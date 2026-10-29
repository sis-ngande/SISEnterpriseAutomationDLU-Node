import axios, { AxiosInstance, Method } from 'axios';
import { ResponseCache } from './responseCache';
import { TemplateLoader, updateField, findByField, setPath } from '../../templates/templateLoader';
import { encodeString2Base64, addDate } from '../../utils/reusableUtils';
import * as Keys from './iWebServiceResponseKeys';

function isBlank(v: string | undefined): boolean {
  return v == null || v.trim() === '' || v.trim().toLowerCase() === 'blank';
}

export interface WebServiceCallResult {
  statusCode: number;
  data: unknown;
  raw: string;
}

/**
 * Port of com.utils.WebserviceUtils + com.utils.ReUsableWebserviceUtils'
 * session-handling subset (createSession/getUserSessionOrg/runWebServiceRequest).
 *
 * One instance of this (via WebServiceClient) is created PER ROW, replacing
 * the Java version's single shared instance - see ResponseCache for why.
 */
export class WebserviceUtils {
  protected token: string | null = null;
  protected oldFacility = '';
  protected oldUserName = '';
  private readonly http: AxiosInstance;
  protected readonly templates: TemplateLoader;

  constructor(protected readonly baseURL: string, protected readonly responseCache: ResponseCache, templatesDir: string) {
    this.http = axios.create({ baseURL, validateStatus: () => true });
    this.templates = new TemplateLoader(templatesDir);
  }

  protected async runWebServiceRequest(payload: unknown, endPoint: string, method: Method): Promise<WebServiceCallResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers.token = this.token;

    const response = await this.http.request({
      url: endPoint,
      method,
      data: payload === '' ? undefined : payload,
      headers,
    });

    const result: WebServiceCallResult = {
      statusCode: response.status,
      data: response.data,
      raw: typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
    };

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failure response for api: ${endPoint} (status ${response.status}) body=${result.raw}`);
    }
    return result;
  }

  private static readonly DEFAULT_TRANSIENT_ERROR = /\(status 500\)/;
  private static readonly BLANK_400_ERROR = /\(status 400\) body=\{"message":""\}/;
  private static readonly DUPLICATE_KEY_CONFLICT = /\(status 409\) body=Duplicate Key Conflict/;

  /**
   * Wraps runWebServiceRequest with a short retry for transient failures under
   * concurrent load (by default: empty-body 500s, or 400s with no real validation
   * message) - seen on endpoints like UpsertCaseSummary when many rows hit shared
   * resources (room/physician schedule) at once. Genuine validation errors (a
   * populated message) are not retried and fail immediately. Pass isTransient to
   * match a different error signature (e.g. a specific 409 Constraint Conflict).
   */
  protected async runWebServiceRequestWithRetryOnTransientFailure(
    payload: unknown,
    endPoint: string,
    method: Method,
    options?: { maxAttempts?: number; isTransient?: (message: string) => boolean }
  ): Promise<WebServiceCallResult> {
    const isTransient =
      options?.isTransient ??
      ((message: string) =>
        WebserviceUtils.DEFAULT_TRANSIENT_ERROR.test(message) ||
        WebserviceUtils.BLANK_400_ERROR.test(message) ||
        WebserviceUtils.DUPLICATE_KEY_CONFLICT.test(message));
    return this.retryOnTransientError(() => this.runWebServiceRequest(payload, endPoint, method), isTransient, options?.maxAttempts);
  }

  /**
   * Retries an arbitrary async operation (a single request, or a multi-step
   * sequence like lock -> write -> release) while isTransient matches the
   * thrown error's message, up to maxAttempts. Rethrows immediately on a
   * non-matching error, or once maxAttempts is exhausted.
   */
  protected async retryOnTransientError<T>(fn: () => Promise<T>, isTransient: (message: string) => boolean, maxAttempts = 4): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isTransient(message) || attempt >= maxAttempts) throw err;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  /**
   * Polls fetchOne (a lookup that may not see a just-created entity yet under
   * concurrent load - e.g. a row consuming another row's concurrently-created
   * insurance carrier/case flag in the same batch) until it returns a truthy
   * result or maxAttempts is reached, whichever comes first.
   */
  protected async pollUntilFound<T>(fetchOne: () => Promise<T | undefined>, maxAttempts = 5, delayMs = 2000): Promise<T | undefined> {
    let result: T | undefined;
    for (let attempt = 0; attempt < maxAttempts && !result; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      result = await fetchOne();
    }
    return result;
  }

  async createSession(facility: string, userID?: string, password?: string): Promise<void> {
    if (this.oldFacility === facility && this.oldUserName === (userID ?? '')) {
      return;
    }
    this.oldFacility = facility;
    this.token = null;

    const relURL = '/login/loginuser';
    let body = this.templates.load<{ UserName: string; Password: string }>('UserDetails.json');
    if (userID) {
      body = updateField(updateField(body, 'UserName', userID), 'Password', password ?? '');
    }
    this.oldUserName = body.UserName;
    this.responseCache.put(Keys.KEY_SESSION_USER_NAME, userID ?? body.UserName);

    const loginResponse = await this.runWebServiceRequest(body, relURL, 'POST');
    this.token = String(loginResponse.raw).replace(/"/g, '');
    this.responseCache.put(Keys.KEY_TOKEN, this.token);

    const orgMapResponse = await this.runWebServiceRequest('', '/User/UserOrgMap', 'GET');
    const orgId = this.getUserSessionOrg(orgMapResponse.data, facility);
    this.responseCache.put(Keys.KEY_ORG_ID, orgId);

    await this.runWebServiceRequest('', `/UserSession/UserSessionOrg/${orgId}`, 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.getDictionaryDetails(dictionaryName, dictionaryValue)
   * (ReUsableWebserviceUtils.java L2942-2962). Resolves a dictionary item id
   * (e.g. Religion="Catholic", Race="Asian", "Anesthesia Type"="General") by
   * name+value, storing the id in the ResponseCache under Keys.KEY_DICTIONARY_ITEM_ID
   * for the caller to read back. Returns false if either lookup misses.
   */
  async getDictionaryDetails(dictionaryName: string, dictionaryValue: string): Promise<boolean> {
    const dictListResponse = await this.runWebServiceRequest('', 'Dictionary/v2', 'GET');
    const dictionaries = Array.isArray(dictListResponse.data) ? dictListResponse.data : JSON.parse(dictListResponse.raw);
    const dictionary = dictionaries.find((d: { name: string }) => d.name?.toLowerCase() === dictionaryName.toLowerCase());
    if (!dictionary) return false;

    const itemsResponse = await this.runWebServiceRequest('', `Dictionary/v2/${dictionary.id}/All`, 'GET');
    const items = Array.isArray(itemsResponse.data) ? itemsResponse.data : JSON.parse(itemsResponse.raw);
    const item = items.find((i: { value: string }) => i.value?.toLowerCase() === dictionaryValue.toLowerCase());
    if (!item) return false;

    this.responseCache.put(Keys.KEY_DICTIONARY_ITEM_ID, item.id);
    return true;
  }

  /** Port of ReUsableWebserviceUtils.getRoomsForOrganization (Room/GetRoomsForOrganization, GET). */
  protected async getRoomsForOrganization(): Promise<WebServiceCallResult> {
    return this.runWebServiceRequest('', 'Room/GetRoomsForOrganization', 'GET');
  }

  /**
   * Port of ReUsableWebserviceUtils.getRoomIdForRoomName (ReUsableWebserviceUtils.java).
   * Throws if the room isn't found for the current session's organization, matching
   * the Java original's RuntimeException rather than silently defaulting.
   */
  protected async getRoomIdForRoomName(roomName: string): Promise<string> {
    const response = await this.getRoomsForOrganization();
    const rooms = (Array.isArray(response.data) ? response.data : JSON.parse(response.raw)) ?? [];
    if (rooms.length === 0) {
      throw new Error(`Room ${roomName} is not present`);
    }
    const room = findByField(rooms as Record<string, unknown>[], 'name', roomName);
    if (!room) {
      throw new Error(`Room ${roomName} is not present`);
    }
    return String(room.roomId);
  }

  /** Port of ReUsableWebserviceUtils.getPhysicianeNameAndID (/StaffList/GetStaffForFacility, POST). */
  protected async getPhysicianeNameAndID(): Promise<WebServiceCallResult> {
    return this.runWebServiceRequest('', '/StaffList/GetStaffForFacility', 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.getPhysicianNameIDFromPhysicianName. Returns
   * [fullName, staffId, physicianId] to match the Java List<Object> shape.
   */
  protected async getPhysicianNameIDFromPhysicianName(physicianName: string): Promise<[string, string, string]> {
    const response = await this.getPhysicianeNameAndID();
    const physicians = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const physician = findByField(physicians as Record<string, unknown>[], 'lastName', physicianName);
    if (!physician) {
      throw new Error(`getPhysicianNameIDFromPhysicianName: no physician found with lastName "${physicianName}"`);
    }
    return [String(physician.fullName), String(physician.staffId), String(physician.personId)];
  }

  /** Port of ReUsableWebserviceUtils.getAppointmentTypeNameAndID (/ApptypeCasepackMap/GetApptypeCasepackMapData, GET). */
  protected async getAppointmentTypeNameAndID(): Promise<WebServiceCallResult> {
    return this.runWebServiceRequest('', '/ApptypeCasepackMap/GetApptypeCasepackMapData', 'GET');
  }

  /**
   * Port of ReUsableWebserviceUtils.getAppointmentType. Resolves the appointment-type
   * record by name and caches it under Keys.KEY_APPOINTMENT_TYPE for
   * getAppointmentTypeId/getAppointmentTypeCaseType to read back.
   */
  protected async getAppointmentType(appointmentTypeName: string): Promise<void> {
    const response = await this.getAppointmentTypeNameAndID();
    const appointmentTypes = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const match = findByField(appointmentTypes as Record<string, unknown>[], 'appointment_Type_Desc', appointmentTypeName);
    if (!match) {
      throw new Error(`getAppointmentType: no appointment type found with name "${appointmentTypeName}"`);
    }
    this.responseCache.put(Keys.KEY_APPOINTMENT_TYPE, match);
  }

  protected getAppointmentTypeId(): number {
    const appointmentType = this.responseCache.get<Record<string, unknown>>(Keys.KEY_APPOINTMENT_TYPE);
    return Number(appointmentType?.appointmentTypeId);
  }

  protected getAppointmentTypeCaseType(): number {
    const appointmentType = this.responseCache.get<Record<string, unknown>>(Keys.KEY_APPOINTMENT_TYPE);
    return Number(appointmentType?.caseTypeAfterStartDate);
  }

  /** Port of ReUsableWebserviceUtils.returnIcdDescFromICDCode (/ICDCodeClassification/GetICDCodeClassifications, POST). */
  protected async returnIcdDescFromICDCode(icdCode: string): Promise<string> {
    const response = await this.runWebServiceRequest(`"${icdCode}"`, '/ICDCodeClassification/GetICDCodeClassifications', 'POST');
    const results = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    return String((results as Record<string, unknown>[])[0].icdCodeDescription);
  }

  /**
   * Port of ReUsableWebserviceUtils.getFeeScheduleByCptCode (/FeeSchedule/Search, POST).
   * Matches the Java original: returns undefined when no fee schedule matches
   * rather than throwing, so callers can still submit the case with the fee
   * schedule fields left blank for that CPT code.
   */
  protected async getFeeScheduleByCptCode(cptCode: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.runWebServiceRequest(`"${encodeString2Base64(cptCode)}"`, '/FeeSchedule/Search', 'POST');
    const result = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const feeSchedule = Array.isArray(result) ? result[0] : result;
    return feeSchedule as Record<string, unknown> | undefined;
  }

  /**
   * Port of ReUsableWebserviceUtils.isPreferenceCardPresent (/PreferenceCardConfig/GetPreferenceCardConfigList, GET).
   * Caches the resolved preferenceCardId under Keys.KEY_PREFERENCE_CARD_ID for
   * getEquipmentDetailsForPreferenceCard/addPreferenceCardToPatient to read back.
   */
  protected async isPreferenceCardPresent(preferenceCardName: string): Promise<boolean> {
    const response = await this.runWebServiceRequest('', '/PreferenceCardConfig/GetPreferenceCardConfigList', 'GET');
    const preferenceCards = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const preferenceCard = findByField(preferenceCards as Record<string, unknown>[], 'preferenceCardName', preferenceCardName);
    if (!preferenceCard) return false;

    this.responseCache.put(Keys.KEY_PREFERENCE_CARD_ID, preferenceCard.preferenceCardId);
    return true;
  }

  /** Port of ReUsableWebserviceUtils.getEquipmentDetailsForPreferenceCard (/PreferenceCardConfig/GetAllPrefCardEquipment, POST). */
  protected async getEquipmentDetailsForPreferenceCard(preferenceCardId: string): Promise<Record<string, unknown>[] | null> {
    const response = await this.runWebServiceRequest(JSON.stringify([preferenceCardId]), '/PreferenceCardConfig/GetAllPrefCardEquipment', 'POST');
    if (response.raw === 'null') return null;
    return Array.isArray(response.data) ? (response.data as Record<string, unknown>[]) : JSON.parse(response.raw);
  }

  /** Port of ReUsableWebserviceUtils.getinsuranceCarriers (InsuranceCarrierObject/GetInsuranceCarriers, GET). */
  protected async getinsuranceCarriers(): Promise<WebServiceCallResult> {
    return this.runWebServiceRequest('', 'InsuranceCarrierObject/GetInsuranceCarriers', 'GET');
  }

  /**
   * Port of ReUsableWebserviceUtils.GetInsurancePlans (InsurancePlan/GetInsurancePlans, POST).
   * Resolves the carrier name to an insuranceCarrierId via getinsuranceCarriers,
   * then returns the first matching insurance plan record.
   */
  protected async getInsurancePlans(carrierName: string): Promise<Record<string, unknown>> {
    // Insurance carriers are created by a separate seed-data row (InsuranceCreation) that
    // often runs concurrently with the row consuming it in the same batch, so a fresh
    // carrier may not be visible yet - retry briefly before treating it as genuinely missing.
    const carrier = await this.pollUntilFound(async () => {
      const carriersResponse = await this.getinsuranceCarriers();
      const carriers = Array.isArray(carriersResponse.data) ? carriersResponse.data : JSON.parse(carriersResponse.raw);
      return findByField(carriers as Record<string, unknown>[], 'insuranceCarrierName', carrierName);
    });
    if (!carrier) {
      throw new Error(`getInsurancePlans: no insurance carrier found with name "${carrierName}"`);
    }

    const response = await this.runWebServiceRequest(
      JSON.stringify({ insuranceCarrierId: Number(carrier.insuranceCarrierId) }),
      'InsurancePlan/GetInsurancePlans',
      'POST'
    );
    const plans = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const plan = plans[0];
    if (!plan) {
      throw new Error(`getInsurancePlans: no insurance plan found for carrier "${carrierName}"`);
    }
    return plan as Record<string, unknown>;
  }

  /**
   * Port of ReUsableWebserviceUtils.addMultipleGuarantorToPatient (PatientGuarantor/SavePatientGuarantor/0, POST).
   * Accumulates guarantor fields into ';'-joined ResponseCache entries so
   * multiple guarantors on the same row can be addressed by index later
   * (matches the Java original's string-concatenation approach, including the
   * pre-existing bug where guarantorDob/guarantorCountry store patientGuarantorId
   * instead of the actual value on first insert).
   */
  protected async addMultipleGuarantorToPatient(
    patientId: string,
    guarantorFirstName: string,
    guarantorLastName: string,
    guarantorDateOfBirth: string,
    guarantorCountry: string,
    guarantorIsActive: boolean
  ): Promise<void> {
    let body = this.templates.load<Record<string, unknown>>('MapGuarantorToPatient.json');
    body = updateField(body, 'patientId', patientId);
    body = updateField(body, 'firstName', guarantorFirstName);
    body = updateField(body, 'lastName', guarantorLastName);
    body = updateField(body, 'dateOfBirth', guarantorDateOfBirth);
    body = updateField(body, 'isActive', guarantorIsActive);
    body = updateField(body, 'country', guarantorCountry);

    const response = await this.runWebServiceRequestWithRetryOnTransientFailure(body, 'PatientGuarantor/SavePatientGuarantor/0', 'POST');
    const parsed = JSON.parse(response.raw);
    const patientGuarantorId = String(parsed.patientGuarantorId);

    const append = (key: string, value: string) => {
      const existing = this.responseCache.getString(key);
      this.responseCache.put(key, existing ? `${existing};${value}` : value);
    };
    append(Keys.KEY_PATIENT_GUARANTOR_ID, patientGuarantorId);
    append(Keys.KEY_GUARANTOR_FIRST_NAME, guarantorFirstName);
    append(Keys.KEY_GUARANTOR_LAST_NAME, guarantorLastName);
    append(Keys.KEY_GUARANTOR_DOB, this.responseCache.has(Keys.KEY_GUARANTOR_DOB) ? guarantorDateOfBirth : patientGuarantorId);
    append(Keys.KEY_GUARANTOR_COUNTRY, this.responseCache.has(Keys.KEY_GUARANTOR_COUNTRY) ? guarantorCountry : patientGuarantorId);
  }

  /**
   * Port of ReUsableWebserviceUtils.insertInsurancetoPatient (/Insurance/Gemini/Insert/0, POST).
   * insuranceAdditionalDetails is a 18-field ','-separated string matching the
   * Java original's fixed-position layout (middleInitial, suffix, dateOfBirth,
   * address1, address2, groupName, groupNumber, city, state, zip, extendedZip,
   * employer, county, country, effectiveFrom, effectiveTo, email, primaryPhone).
   */
  protected async insertInsurancetoPatient(
    relationshipToSubscriber: string,
    firstName: string,
    lastName: string,
    gender: string,
    subscriberId: string,
    carrierName: string,
    insuranceAdditionalDetails: string | undefined
  ): Promise<WebServiceCallResult> {
    const patientRaw = this.responseCache.get<string>(Keys.KEY_CREATE_PATIENT_RESPONSE);
    if (!patientRaw) {
      throw new Error('insertInsurancetoPatient: no cached patient response - createJustAPatient must run first');
    }
    const patient = JSON.parse(patientRaw);
    const insurancePlan = await this.getInsurancePlans(carrierName);

    let body = this.templates.load<Record<string, unknown>>('InsertInsurancetoPatient.json');
    body = updateField(body, 'patientId', patient.patientId);
    body = updateField(body, 'organizationId', this.responseCache.getString(Keys.KEY_ORG_ID));
    body = updateField(body, 'insuranceId', Number(insurancePlan.insurancePlanId));
    body = updateField(body, 'planName', insurancePlan.planName);
    body = updateField(body, 'insuranceCarrierId', Number(insurancePlan.insuranceCarrierId));
    body = updateField(body, 'carrier', carrierName);
    body = updateField(body, 'insurancePlanId', Number(insurancePlan.insurancePlanId));
    body = updateField(body, 'insuranceClaimOfficeId', Number(insurancePlan.claimOfficeId));
    body = updateField(body, 'relationshipToInsured', relationshipToSubscriber);
    body = updateField(body, 'displayName', subscriberId);
    body = updateField(body, 'firstName', firstName);
    body = updateField(body, 'lastName', lastName);
    body = updateField(body, 'gender', gender);

    if (insuranceAdditionalDetails && insuranceAdditionalDetails.trim() !== '' && insuranceAdditionalDetails.toLowerCase() !== 'blank') {
      const parts = insuranceAdditionalDetails.split(',');
      const orNull = (v: string | undefined) => (v && v.toLowerCase() !== 'blank' ? v : null);
      body = updateField(body, 'middleInitial', orNull(parts[0]));
      body = updateField(body, 'suffix', orNull(parts[1]));
      body = updateField(body, 'dateOfBirth', orNull(parts[2]));
      body = updateField(body, 'address1', orNull(parts[3]));
      body = updateField(body, 'address2', orNull(parts[4]));
      body = updateField(body, 'groupName', orNull(parts[5]));
      body = updateField(body, 'groupNumber', orNull(parts[6]));
      body = updateField(body, 'city', orNull(parts[7]));
      body = updateField(body, 'state', orNull(parts[8]));
      const zipCode = orNull(parts[9]);
      body = updateField(body, 'zipCode', zipCode ? `${zipCode}-${parts[10]}` : null);
      body = updateField(body, 'employer', orNull(parts[11]));
      body = updateField(body, 'countyName', orNull(parts[12]));
      body = updateField(body, 'countryName', orNull(parts[13]));
      body = updateField(body, 'effectiveFrom', orNull(parts[14]));
      body = updateField(body, 'effectiveTo', orNull(parts[15]));
      body = updateField(body, 'email', orNull(parts[16]));
      body = updateField(body, 'primaryPhone', orNull(parts[17]));
    }

    return this.runWebServiceRequest(body, '/Insurance/Gemini/Insert/0', 'POST');
  }

  /** Port of ReUsableWebserviceUtils.GetPatientInsurancesByPatientId. */
  protected async getPatientInsurancesByPatientId(): Promise<WebServiceCallResult> {
    const patientId = this.responseCache.getString(Keys.KEY_PATIENT_ID);
    return this.runWebServiceRequest('', `Insurance/Gemini/GetPatientInsurancesByPatientId/${patientId}`, 'GET');
  }

  private static readonly TRANSACTION_TYPE_IDS: Record<string, number> = {
    'write-off': 4,
    payment: 2,
    charge: 1,
    'unassigned payment': 3,
    correction: 5,
    debit: 6,
    transfer: 7,
    allocation: 8,
  };

  /**
   * Port of ReUsableWebserviceUtils.createNewTransactionCode (TransactionCode/UpsertTransactionCode, POST x2).
   * transtypeid defaults to 0 for an unrecognized transactiontype, matching the
   * Java original (no else branch / no error on an unmatched type name).
   */
  protected async createNewTransactionCode(transactionCodeName: string, transactiontype: string): Promise<void> {
    const relURL = 'TransactionCode/UpsertTransactionCode';
    const response = await this.runWebServiceRequest(JSON.stringify({ transactionCodeName }), relURL, 'POST');
    const transResp = JSON.parse(response.raw) as Record<string, unknown>;

    transResp.transactionTypeId = WebserviceUtils.TRANSACTION_TYPE_IDS[transactiontype.toLowerCase()] ?? 0;
    transResp.transactionType = transactiontype;

    await this.runWebServiceRequest(transResp, relURL, 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.saveInsuranceCarrier (InsuranceCarrierObject/SaveInsuranceCarrier, PUT).
   * On failure, falls back to verifyExistanceofinsurance (matching Java's
   * catch-RuntimeException-and-check-for-duplicate behavior) - returns null if
   * the insurance already exists, otherwise re-throws.
   */
  protected async saveInsuranceCarrier(
    insuranceName: string,
    planName: string,
    insuranceClassification: string,
    electronicClaim: string | undefined,
    paperForm: string | undefined,
    ePayerCode: string | undefined
  ): Promise<WebServiceCallResult | null> {
    const body: Record<string, unknown> = {
      electronicClaim: 1,
      paperForm: 1,
      insuranceCarrierId: 0,
      insuranceCarrierName: insuranceName,
      ePayerId: ePayerCode,
      insurancePlanSaveDetails: {
        defaultPlanTf: true,
        isInsurancePlanValid: false,
        planName,
        classification: insuranceClassification,
        primaryEmcPayerid: '066020',
        claimOfficeId: null,
      },
    };

    if (electronicClaim && electronicClaim !== '') {
      let electronicClaimValue = 0;
      if (electronicClaim.toLowerCase() === 'institutional') electronicClaimValue = 1;
      if (electronicClaim.toLowerCase() === 'professional') electronicClaimValue = 2;
      body.electronicClaim = electronicClaimValue;
    }
    if (paperForm && paperForm !== '') {
      let paperFormValue = 0;
      if (paperForm.toLowerCase() === 'ub') paperFormValue = 1;
      if (paperForm.toLowerCase() === 'hcfa') paperFormValue = 2;
      body.paperForm = paperFormValue;
    }

    try {
      const response = await this.runWebServiceRequest(body, 'InsuranceCarrierObject/SaveInsuranceCarrier', 'PUT');
      const parsed = JSON.parse(response.raw) as Record<string, unknown>;
      this.responseCache.put(Keys.KEY_INSURANCE_CARRIER_ID, String(parsed.insuranceCarrierId));
      const planSaveDetails = parsed.insurancePlanSaveDetails as Record<string, unknown> | undefined;
      this.responseCache.put(Keys.KEY_INSURANCE_PLAN_ID, planSaveDetails ? String(planSaveDetails.insurancePlanId) : undefined);
      return response;
    } catch (err) {
      const exists = await this.verifyExistanceofinsurance(insuranceName, planName);
      if (exists) return null;
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Exception occured while saving Insurance Carrier "${insuranceName}": ${reason}`);
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.verifyExistanceofinsurance. The Java original's
   * second lookup uses a null relURL (a latent bug in the source) - this port uses
   * the real endpoint (InsurancePlan/GetInsurancePlans) instead of replicating a
   * call that would always fail.
   */
  protected async verifyExistanceofinsurance(insuranceName: string, insurancePlanName: string): Promise<boolean> {
    try {
      const carriersResponse = await this.getinsuranceCarriers();
      const carriers = Array.isArray(carriersResponse.data) ? carriersResponse.data : JSON.parse(carriersResponse.raw);
      const carrier = findByField(carriers as Record<string, unknown>[], 'insuranceCarrierName', insuranceName);
      if (!carrier) return false;

      const insuranceCarrierId = Number(carrier.insuranceCarrierId);
      this.responseCache.put(Keys.KEY_INSURANCE_CARRIER_ID, insuranceCarrierId);

      const plansResponse = await this.runWebServiceRequest(
        JSON.stringify({ insuranceCarrierId }),
        'InsurancePlan/GetInsurancePlans',
        'POST'
      );
      const plans = Array.isArray(plansResponse.data) ? plansResponse.data : JSON.parse(plansResponse.raw);
      const plan = findByField(plans as Record<string, unknown>[], 'planName', insurancePlanName);
      if (!plan) return false;

      this.responseCache.put(Keys.KEY_INSURANCE_PLAN_ID, String(plan.insurancePlanId));
      this.responseCache.put(Keys.KEY_INSURANCE_CLAIM_OFFICE_ID, plan.claimOfficeId ?? null);
      return true;
    } catch {
      return false;
    }
  }

  /** Port of ReUsableWebserviceUtils.insertInsuranceClaimOffice (Insurance/InsertInsuranceClaimOffice, POST). */
  protected async insertInsuranceClaimOffice(
    insuranceCarrierObjectId: string,
    officeName: string,
    line1: string,
    city: string,
    contactName: string,
    phone: string,
    zip: string,
    extendedZip: string,
    state: string
  ): Promise<WebServiceCallResult> {
    const body = {
      country: 'United States',
      name: officeName,
      line1,
      city,
      state,
      zip,
      extendedZip,
      phone,
      contactName,
      insuranceCarrierObjectId,
    };
    const response = await this.runWebServiceRequest(body, 'Insurance/InsertInsuranceClaimOffice', 'POST');
    const parsed = JSON.parse(response.raw) as Record<string, unknown>;
    this.responseCache.put(Keys.KEY_INSURANCE_CLAIM_OFFICE_ID, parsed.claimOfficeId ?? null);
    return response;
  }

  /** Port of ReUsableWebserviceUtils.updateInsuranceClaimOffice (Insurance/UpdateInsuranceClaimOffice, POST). */
  protected async updateInsuranceClaimOffice(
    insuranceCarrierObjectId: string,
    officeName: string,
    line1: string,
    city: string,
    contactName: string,
    phone: string,
    zip: string,
    extendedZip: string,
    state: string
  ): Promise<WebServiceCallResult> {
    let body = this.templates.load<Record<string, unknown>>('InsertInsuranceClaimOffice.json');
    body = updateField(body, 'claimOfficeId', Number(this.responseCache.get(Keys.KEY_INSURANCE_CLAIM_OFFICE_ID)));
    body = updateField(body, 'insuranceCarrierObjectId', insuranceCarrierObjectId);
    body = updateField(body, 'name', officeName);
    body = updateField(body, 'line1', line1);
    body = updateField(body, 'city', city);
    body = updateField(body, 'contactName', contactName);
    body = updateField(body, 'phone', phone);
    body = updateField(body, 'zip', zip);
    body = updateField(body, 'extendedZip', extendedZip);
    body = updateField(body, 'state', state);
    return this.runWebServiceRequest(body, 'Insurance/UpdateInsuranceClaimOffice', 'POST');
  }

  /** Port of ReUsableWebserviceUtils.retrieveContracts (/InsuranceContract/GetInsuranceContractList, GET). */
  protected async retrieveContracts(contractName: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.runWebServiceRequest('', '/InsuranceContract/GetInsuranceContractList', 'GET');
    const contracts = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    return findByField(contracts as Record<string, unknown>[], 'insuranceContractName', contractName);
  }

  /**
   * Port of ReUsableWebserviceUtils.createDictionary. Idempotent: no-ops if the
   * dictionary itself isn't found, or the item already exists under it.
   */
  protected async createDictionary(dictionaryName: string, dictionaryItemName: string, showInClinicalTf: boolean): Promise<void> {
    const dictListResponse = await this.runWebServiceRequest('', 'Dictionary/v2', 'GET');
    const dictionaries = Array.isArray(dictListResponse.data) ? dictListResponse.data : JSON.parse(dictListResponse.raw);
    const dictionary = (dictionaries as Record<string, unknown>[]).find((d) => String(d.name).toLowerCase() === dictionaryName.toLowerCase());
    if (!dictionary) return;

    const itemsResponse = await this.runWebServiceRequest('', `Dictionary/v2/${dictionary.id}/All`, 'GET');
    const items = Array.isArray(itemsResponse.data) ? itemsResponse.data : JSON.parse(itemsResponse.raw);
    const alreadyPresent = (items as Record<string, unknown>[]).some((i) => String(i.value).toLowerCase() === dictionaryItemName.toLowerCase());
    if (alreadyPresent) return;

    let body = this.templates.load<Record<string, unknown>>('DictionaryAdd.json');
    body = updateField(body, 'dictionary', dictionaryName);
    body = updateField(body, 'dictionaryId', dictionary.id);
    body = updateField(body, 'value', dictionaryItemName);
    body = updateField(body, 'showInClinicalTf', showInClinicalTf);

    await this.runWebServiceRequest(body, `Dictionary/v2/${dictionary.id}/Add`, 'POST');
  }

  /** Port of ReUsableWebserviceUtils.opNoteConfigurationAdd (/OpNoteConfiguration/Add, POST). Returns the new opNoteId. */
  protected async opNoteConfigurationAdd(opNoteName: string): Promise<number> {
    const response = await this.runWebServiceRequest({ opNoteName }, '/OpNoteConfiguration/Add', 'POST');
    return Number(response.raw);
  }

  /**
   * Port of ReUsableWebserviceUtils.updateOpNoteConfiguration (/OpNoteConfiguration/Update, POST).
   * physicianname is a ','-separated list of staff lastNames mapped into physicianMappings.
   */
  protected async updateOpNoteConfiguration(opNoteId: number, opNoteName: string, physicianname: string, opNoteText: string): Promise<void> {
    let body = this.templates.load<Record<string, unknown>>('UpdateOpNoteConfiguration.json');
    body = updateField(body, 'opNoteId', opNoteId);
    body = updateField(body, 'opNoteName', opNoteName);
    body = updateField(body, 'organizationId', Number(this.responseCache.getString(Keys.KEY_ORG_ID)));
    setPath(body, 'textObject.opNoteId', opNoteId);
    setPath(body, 'variableObject.opNoteId', opNoteId);
    setPath(body, 'textObject.noteText', encodeString2Base64(opNoteText));

    const physicianMappings: Record<string, unknown>[] = [];
    for (const name of physicianname.split(',')) {
      const [, staffId] = await this.getPhysicianNameIDFromPhysicianName(name);
      physicianMappings.push({ staffId: Number(staffId) });
    }
    body = updateField(body, 'physicianMappings', physicianMappings);

    await this.runWebServiceRequest(body, '/OpNoteConfiguration/Update', 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.addMessageTemplate (/PointInTimeTemplate/Upsert, POST).
   * communicationType: 1=SMS (default), 2=Email. targetPlatform: 1=Clinical (default), 2=Business, 3=Both.
   */
  protected async addMessageTemplate(templateName: string, desktop: string, messageType: string, body: string, emailSubject: string): Promise<void> {
    const payload: Record<string, unknown> = {
      title: encodeString2Base64(templateName),
      id: 0,
    };

    if (messageType.toLowerCase() === 'email') {
      payload.communicationType = 2;
      payload.emailSubject = encodeString2Base64(emailSubject);
      payload.emailBody = encodeString2Base64(body);
    } else {
      payload.communicationType = 1;
      payload.smsMessage = encodeString2Base64(body);
    }

    let targetPlatform = 1;
    if (desktop.toLowerCase() === 'business') targetPlatform = 2;
    if (desktop.toLowerCase() === 'both') targetPlatform = 3;
    payload.targetPlatform = targetPlatform;

    await this.runWebServiceRequest(payload, '/PointInTimeTemplate/Upsert', 'POST');
  }

  /** Port of ReUsableWebserviceUtils.addNewOrder (POST to the given relURL). Caches physicianOrderId under Keys.KEY_PHYSICIAN_ORDER_ID. */
  protected async addNewOrder(name: string, relUrl: string): Promise<void> {
    const response = await this.runWebServiceRequestWithRetryOnTransientFailure({ name }, relUrl, 'POST');
    const parsed = JSON.parse(response.raw);
    this.responseCache.put(Keys.KEY_PHYSICIAN_ORDER_ID, parsed.physicianOrderId);
  }

  /**
   * Port of ReUsableWebserviceUtils.updateBaseOrder (PhysicianOrdersConfiguration/BaseOrder, PUT).
   * departmentId mapping is a fixed 3-value lookup, matching the Java original: Recovery=1060,
   * Pre-Operative=1020, Operative=1030, else 0.
   */
  protected async updateBaseOrder(department: string, departmentOrderText: string): Promise<void> {
    const departmentIdMap: Record<string, number> = { recovery: 1060, 'pre-operative': 1020, operative: 1030 };
    let body = this.templates.load<Record<string, unknown>>('BaseOrder.json');
    body = updateField(body, 'departmentId', departmentIdMap[department.toLowerCase()] ?? 0);
    body = updateField(body, 'physicianOrderId', this.responseCache.get(Keys.KEY_PHYSICIAN_ORDER_ID));
    setPath(body, 'textOrder.text', departmentOrderText);

    await this.runWebServiceRequest(body, 'PhysicianOrdersConfiguration/BaseOrder', 'PUT');
  }

  /**
   * Port of ReUsableWebserviceUtils.UpdatePhysicians (PhysicianOrdersConfiguration/PhysicianOrder/{id}/UpdatePhysicians, PUT).
   * physicianname is ','-separated staff lastNames, appended to any existing mapped staffIds.
   */
  protected async updatePhysiciansForOrder(physicianname: string): Promise<void> {
    const physicianOrderId = this.responseCache.get(Keys.KEY_PHYSICIAN_ORDER_ID);
    const configResponse = await this.runWebServiceRequest('', `PhysicianOrdersConfiguration/${physicianOrderId}`, 'GET');
    const config = typeof configResponse.data === 'object' && configResponse.data !== null ? configResponse.data : JSON.parse(configResponse.raw);
    const existingStaffIds = ((config as Record<string, unknown>).orderPhysicians as Record<string, unknown>[] | undefined)?.map((p) => p.staffId) ?? [];

    const staffIds = [...existingStaffIds];
    for (const name of physicianname.split(',')) {
      const [, staffId] = await this.getPhysicianNameIDFromPhysicianName(name);
      staffIds.push(staffId);
    }

    await this.runWebServiceRequest(
      `[${staffIds.join(',')}]`,
      `PhysicianOrdersConfiguration/PhysicianOrder/${physicianOrderId}/UpdatePhysicians`,
      'PUT'
    );
  }

  private static readonly POSTING_OPTION_IDS: Record<string, number> = {
    'cost+%': 1,
    'flat fee': 2,
    'standard fee with discount': 3,
    'not covered, full write-off': 4,
    'not covered, no write-off': 5,
  };

  /**
   * Port of ReUsableWebserviceUtils.UpsertPricingOptionConfigItem and its 4 sub-methods
   * (addRevenueCodePricingToContract, addSupplyPricingToContract,
   * addSupplyCategoryPricingToContract, addcontractSupplyPricingToContract). Each sub-payload
   * is independently PUT to the same endpoint; a failure in one (e.g. contract not found)
   * doesn't block the others, matching Java's per-sub-method try/catch.
   */
  protected async upsertPricingOptionConfigItem(
    contractName: string,
    revenueCode: string,
    revCodePostingMethod: string,
    revCodefeeOrCostPercentage: string,
    supplyCostMin: string,
    supplyCostMax: string,
    supplyCostPostingMethod: string,
    supplyCostfeeOrCostPercentage: string,
    supplyCategory: string,
    supplyCategoryPostingMethod: string,
    supplyCategoryfeeOrCostPercentage: string,
    supplyItemName: string,
    supplyItemPostingMethod: string,
    supplyItemfeeOrCostPercentage: string
  ): Promise<void> {
    const relUrl = 'InsuranceContract/UpsertPricingOptionConfigItem';
    const contract = await this.retrieveContracts(contractName);
    if (!contract) return;
    const insuranceContractId = Number(contract.insuranceContractId);
    const posting = (m: string) => WebserviceUtils.POSTING_OPTION_IDS[m.toLowerCase()] ?? 0;

    try {
      const revCodes = revenueCode.split(':');
      const feePercents = revCodefeeOrCostPercentage.split(':');
      const postingMethods = revCodePostingMethod.split(':');
      for (let i = 0; i < revCodes.length; i++) {
        if (isBlank(revCodes[i])) continue;
        await this.runWebServiceRequest(
          {
            insuranceContractId,
            contractSupplyPricingConfigId: 0,
            isValidationError: false,
            errorDescription: null,
            revenueCode: revCodes[i],
            pricingTypeId: 4,
            feeOrCostPercentage: feePercents[i],
            postingOptionId: posting(postingMethods[i] ?? ''),
          },
          relUrl,
          'PUT'
        );
      }
    } catch {
      // Matches Java: each sub-payload's failure is swallowed independently.
    }

    try {
      const mins = supplyCostMin.split(':');
      const maxs = supplyCostMax.split(':');
      const feePercents = supplyCostfeeOrCostPercentage.split(':');
      const postingMethods = supplyCostPostingMethod.split(':');
      for (let i = 0; i < mins.length; i++) {
        if (isBlank(mins[i])) continue;
        await this.runWebServiceRequest(
          {
            insuranceContractId,
            contractSupplyPricingConfigId: 0,
            isValidationError: false,
            errorDescription: null,
            minCost: mins[i],
            maxCost: maxs[i],
            pricingTypeId: 3,
            feeOrCostPercentage: feePercents[i],
            postingOptionId: posting(postingMethods[i] ?? ''),
          },
          relUrl,
          'PUT'
        );
      }
    } catch {
      // Matches Java: swallowed independently.
    }

    try {
      const categoryIds: Record<string, number> = { equipment: 1, implants: 2, instrument: 3, medications: 4, supply: 5 };
      const categories = supplyCategory.split(':');
      const feePercents = supplyCategoryfeeOrCostPercentage.split(':');
      const postingMethods = supplyCategoryPostingMethod.split(':');
      for (let i = 0; i < categories.length; i++) {
        if (isBlank(categories[i])) continue;
        await this.runWebServiceRequest(
          {
            insuranceContractId,
            contractSupplyPricingConfigId: 0,
            isValidationError: false,
            errorDescription: null,
            pricingTypeId: 2,
            feeOrCostPercentage: feePercents[i],
            supplyCategoryId: categoryIds[categories[i].toLowerCase()] ?? 0,
            postingOptionId: posting(postingMethods[i] ?? ''),
          },
          relUrl,
          'PUT'
        );
      }
    } catch {
      // Matches Java: swallowed independently.
    }

    const supplyItemNames = supplyItemName.split(':');
    const feePercents = supplyItemfeeOrCostPercentage.split(':');
    const postingMethods = supplyItemPostingMethod.split(':');
    for (let i = 0; i < supplyItemNames.length; i++) {
      if (isBlank(supplyItemNames[i])) continue;
      const found = await this.getSupplyDetails(supplyItemNames[i]);
      if (!found) continue;
      await this.runWebServiceRequest(
        {
          insuranceContractId,
          contractSupplyPricingConfigId: 0,
          isValidationError: false,
          errorDescription: null,
          pricingTypeId: 1,
          feeOrCostPercentage: feePercents[i],
          inventoryExternalIdentifier: String(this.responseCache.get(Keys.KEY_SUPPLY_EXTERNAL_ID)),
          supplyItemDescription: String(this.responseCache.get(Keys.KEY_SUPPLY_ID)),
          postingOptionId: posting(postingMethods[i] ?? ''),
        },
        relUrl,
        'PUT'
      );
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.createNewUser (User/CreateNewUser, POST).
   * Caches personId/usrId under Keys.KEY_STAFF_ID/none-yet - returns [personId, usrId].
   */
  protected async createNewUser(firstName: string, middleInitial: string, lastName: string, title: string): Promise<[string, string]> {
    let body = this.templates.load<Record<string, unknown>>('CreateNewUser.json');
    body = updateField(body, 'firstName', firstName);
    body = updateField(body, 'middleInitial', middleInitial);
    body = updateField(body, 'lastName', lastName);

    const response = await this.runWebServiceRequest(body, 'User/CreateNewUser', 'POST');
    const parsed = JSON.parse(response.raw);
    const personId = String(parsed.personId);
    const usrId = String(parsed.usrId);

    await this.addTittle(firstName, lastName, title, middleInitial, personId, usrId);
    return [personId, usrId];
  }

  /**
   * Port of ReUsableWebserviceUtils.addTittle (/User/V2/UpdateUserAccount, POST). Always called
   * after createNewUser, even with a blank title. Java never checks this call's response status
   * at all (unlike its sibling calls, which at least log success/failure) - matching that
   * fire-and-forget fidelity, failures here are swallowed rather than failing the whole row.
   */
  protected async addTittle(firstName: string, lastName: string, title: string, middleInitial: string, personId: string, usrId: string): Promise<void> {
    try {
      await this.runWebServiceRequest(
        { personId: Number(personId), firstName, middleInitial, lastName, title, usrId: Number(usrId) },
        '/User/V2/UpdateUserAccount',
        'POST'
      );
    } catch {
      // intentionally swallowed - see doc comment above
    }
  }

  /** Port of ReUsableWebserviceUtils.turnOnEnterpriseAccess (/User/UpdateOnlyUserOrganizationMap, POST). */
  protected async turnOnEnterpriseAccess(usrId: string): Promise<void> {
    await this.runWebServiceRequest(
      {
        usrId: Number(usrId),
        profileLevelId: 1,
        isUserPassword: false,
        isUserExist: false,
        organizationId: 1,
        activeTf: true,
        lockedTf: false,
      },
      '/User/UpdateOnlyUserOrganizationMap',
      'POST'
    );
  }

  /**
   * Port of ReUsableWebserviceUtils.SetUserOrganizationAssignment (Profile/SetUserOrganizationAssignment, POST)
   * + StaffUpsert (Staff/Upsert, PUT). Resolves profileLevelId (GET Profile, matched by
   * profileAccessLevelName), roleId (GET User/Roles, matched by text), and organizationId
   * (GET Organization/GetAllBusinessEntities, matched by name).
   */
  protected async setUserOrganizationAssignment(usrId: string, personId: string, businessFacility: string, profileName: string, roleName: string): Promise<void> {
    const profilesResponse = await this.runWebServiceRequest('', 'Profile', 'GET');
    const profiles = Array.isArray(profilesResponse.data) ? profilesResponse.data : JSON.parse(profilesResponse.raw);
    const profile = findByField(profiles as Record<string, unknown>[], 'profileAccessLevelName', profileName);

    const rolesResponse = await this.runWebServiceRequest('', 'User/Roles', 'GET');
    const roles = Array.isArray(rolesResponse.data) ? rolesResponse.data : JSON.parse(rolesResponse.raw);
    const role = findByField(roles as Record<string, unknown>[], 'text', roleName);

    const orgsResponse = await this.runWebServiceRequest('', 'Organization/GetAllBusinessEntities', 'GET');
    const orgs = Array.isArray(orgsResponse.data) ? orgsResponse.data : JSON.parse(orgsResponse.raw);
    const org = findByField(orgs as Record<string, unknown>[], 'name', businessFacility);

    let body = this.templates.load<Record<string, unknown>>('SetUserOrganizationAssignment.json');
    body = updateField(body, 'organizationId', org?.organizationId);
    body = updateField(body, 'organizationName', businessFacility);
    body = updateField(body, 'profileLevelId', profile?.profileLevelId);
    body = updateField(body, 'profileLevelName', profileName);
    body = updateField(body, 'roleId', role?.id ?? null);
    body = updateField(body, 'roleName', roleName);
    body = updateField(body, 'usrId', Number(usrId));

    await this.runWebServiceRequest(body, 'Profile/SetUserOrganizationAssignment', 'POST');
    await this.runWebServiceRequest(
      { activeTf: true, businessEntityId: org?.organizationId, roleId: role?.id ?? null, personId: Number(personId), staffId: -1 },
      'Staff/Upsert',
      'PUT'
    );
  }

  /** Port of ReUsableWebserviceUtils.UpdateEmailUser (User/V2/UpsertUserDetails?emailChanged=false, POST). */
  protected async updateEmailUser(emailAddress: string, personId: string): Promise<void> {
    await this.runWebServiceRequest({ emailAddress, personId: Number(personId) }, 'User/V2/UpsertUserDetails?emailChanged=false', 'POST');
  }

  /** Port of ReUsableWebserviceUtils.getPaymentTransactionCodeListByType (TransactionCode/GetTransactionCodeList, GET). Matched by transactionCodeName. */
  protected async getPaymentTransactionCodeId(transactionCodeName: string): Promise<number | undefined> {
    const response = await this.runWebServiceRequest('', 'TransactionCode/GetTransactionCodeList', 'GET');
    const codes = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const code = findByField(codes as Record<string, unknown>[], 'transactionCodeName', transactionCodeName);
    return code ? Number(code.transactionCodeId) : undefined;
  }

  /**
   * Shared builder for addPaymentTransaction/addNewWriteoffTransaction - both resolve the same
   * write-off group/reason/transaction-code and pull the same batch/charge-detail fields from
   * the cached charge-entry response (set by PatientCreation's charge-entry phase), differing
   * only in the wrapping shape (array-of-transaction vs bare transaction) and endpoint.
   */
  private async buildPaymentTransactionObject(
    writeOffGroupCode: string,
    writeOffReasonCode: string,
    amountValue: string,
    transactionCodeName: string
  ): Promise<Record<string, unknown>> {
    const chargeEntryResponse = this.responseCache.get<Record<string, unknown>>(Keys.KEY_CHARGE_ENTRY_RESPONSE);
    const chargeDetails = this.responseCache.get<Record<string, unknown>>(Keys.KEY_CHARGE_DETAILS_RESP);
    if (!chargeEntryResponse || !chargeDetails) {
      throw new Error('buildPaymentTransactionObject: no cached charge-entry response - PatientCreation charge entry must run first');
    }
    const result = ((chargeEntryResponse.result as Record<string, unknown>[]) ?? [])[0];
    const transactionList = (result?.transactionList as Record<string, unknown>[]) ?? [];
    const batchId = transactionList[0]?.batchId;
    const transactionId = chargeDetails.transactionId;

    const writeoffGroupId = await this.getWriteOffGroupId(writeOffGroupCode);
    const writeoffReasonId = await this.getWriteOffReasonId(writeOffReasonCode);
    const transactionCodeId = await this.getPaymentTransactionCodeId(transactionCodeName);
    const now = new Date().toISOString();

    return {
      amount: amountValue,
      isDeleted: false,
      isHidden: false,
      transactionId: 0,
      transactionCodeId,
      writeOffDetails: { transactionId: 0, writeoffReasonId, writeoffGroupId, writeOffGroupDescription: '', writeoffReasonDescription: '' },
      batchId,
      transactionDate: now,
      transactionParentId: transactionId,
      transactionRootId: transactionId,
      postedDate: now,
      chargeDetails: { ...chargeDetails, balance: Number(amountValue) },
      isPaymentTransfer: false,
      receivedFrom: null,
      isEditable: false,
      createdDate: now,
      paymentDetails: { transactionId: 0, paymentTypeId: null },
    };
  }

  /** Port of ReUsableWebserviceUtils.addPaymentTransaction (Transactions/SavePaymentTransactions/60, POST). amount is ';'-separated. */
  protected async addPaymentTransaction(writeOffGroupCode: string, writeOffReasonCode: string, amount: string, transactionCodeName: string): Promise<void> {
    for (const amountValue of amount.split(';')) {
      const transaction = await this.buildPaymentTransactionObject(writeOffGroupCode, writeOffReasonCode, amountValue, transactionCodeName);
      await this.runWebServiceRequest([{ transaction, toResponsibleParty: {} }], 'Transactions/SavePaymentTransactions/60', 'POST');
    }
  }

  /** Port of ReUsableWebserviceUtils.addNewWriteoffTransaction (Transactions/SaveTransaction/60, POST). amount is ';'-separated. */
  protected async addNewWriteoffTransaction(writeOffGroupCode: string, writeOffReasonCode: string, amount: string, transactionCodeName: string): Promise<void> {
    const chargeEntryResponse = this.responseCache.get<Record<string, unknown>>(Keys.KEY_CHARGE_ENTRY_RESPONSE);
    const result = ((chargeEntryResponse?.result as Record<string, unknown>[]) ?? [])[0];
    const transactionList = (result?.transactionList as Record<string, unknown>[]) ?? [];
    const periodId = transactionList[0]?.periodId;

    for (const amountValue of amount.split(';')) {
      const transaction = await this.buildPaymentTransactionObject(writeOffGroupCode, writeOffReasonCode, amountValue, transactionCodeName);
      transaction.periodId = periodId;
      await this.runWebServiceRequest({ transaction }, 'Transactions/SaveTransaction/60', 'POST');
    }
  }

  /** Port of ReUsableWebserviceUtils.getBlockColorThemes (/ColorTheme/GetAllColorThemes, GET). Matched by name. */
  protected async getBlockColorThemes(colorName: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.runWebServiceRequest('', '/ColorTheme/GetAllColorThemes', 'GET');
    const themes = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    return findByField(themes as Record<string, unknown>[], 'name', colorName);
  }

  /** Port of ReUsableWebserviceUtils.getActiveORRoomsForOrganization (/Room/GetActiveORRoomsForOrganization, GET). Matched by name. */
  protected async getActiveORRoomForOrganization(roomName: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.runWebServiceRequest('', '/Room/GetActiveORRoomsForOrganization', 'GET');
    const rooms = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    return findByField(rooms as Record<string, unknown>[], 'name', roomName);
  }

  /**
   * Port of ReUsableWebserviceUtils.createBlockNote. Builds and submits a block-schedule
   * instance: color theme, room(s), physician(s), and case-pack speciality. Java also fires
   * two check-only calls (IsBlockExists, GetBlockConflicts) whose responses aren't used for
   * anything besides population - preserved here for parity since the final SaveBlockInstance
   * call is what actually creates the block.
   */
  protected async createBlockNote(
    blockName: string,
    rooms: string,
    physicians: string,
    date: string,
    startTime: string,
    endTime: string,
    speciality: string,
    blockColor: string,
    blockOut: string
  ): Promise<void> {
    const body: Record<string, unknown> = {
      name: blockName,
      manuallyCreated: true,
      isNewBlockTabActive: true,
      blockOutTf: blockOut.toLowerCase() === 'true',
    };

    if (!isBlank(blockColor)) {
      const colorTheme = await this.getBlockColorThemes(blockColor);
      if (colorTheme) body.colorThemeId = colorTheme.colorThemeId;
    }

    const roomIdList: unknown[] = [];
    for (const roomName of rooms.split(',')) {
      const room = await this.getActiveORRoomForOrganization(roomName);
      if (room) {
        roomIdList.push(room.roomId);
        body.roomId = room.roomId;
      }
    }
    body.roomIdList = roomIdList;

    await this.runWebServiceRequest(body, '/BlockSchedule/IsBlockExists', 'POST');

    const formattedDate = addDate(date, 'yyyy-MM-dd');
    body.startTime = `${formattedDate}T${startTime}:00-0500`;
    body.endTime = `${formattedDate}T${endTime}:00-0500`;

    const physicianMaps: Record<string, unknown>[] = [];
    for (const physicianName of physicians.split(',')) {
      const [, , personId] = await this.getPhysicianNameIDFromPhysicianName(physicianName);
      physicianMaps.push({ blockScheduleInstanceId: 0, physicianId: Number(personId) });
    }
    body.blockScheduleInstancePhysicianMaps = physicianMaps;

    await this.runWebServiceRequest(body, '/BlockScheduleConflictCheck/GetBlockConflicts', 'POST');

    const casePack = await this.getCaseDetails(speciality);
    if (casePack) body.chartPackId = casePack.casePackId;

    await this.runWebServiceRequest(body, '/BlockSchedule/SaveBlockInstance', 'POST');
  }

  /** Port of ReUsableWebserviceUtils.addAnesthesiaBlockNote (/RegionalAnesthesiaTemplate/Add, POST). Returns the new blockNoteId. */
  protected async addAnesthesiaBlockNote(blockNote: string): Promise<number> {
    const response = await this.runWebServiceRequestWithRetryOnTransientFailure(
      { opNoteName: blockNote },
      '/RegionalAnesthesiaTemplate/Add',
      'POST'
    );
    return Number(response.raw);
  }

  /** Port of ReUsableWebserviceUtils.updateAnesBlockNote (/RegionalAnesthesiaTemplate/Update, POST). */
  protected async updateAnesBlockNote(blockNote: string, blockNoteId: number, textArea: string): Promise<void> {
    const body = {
      opNoteId: blockNoteId,
      organizationId: Number(this.responseCache.getString(Keys.KEY_ORG_ID)),
      opNoteName: blockNote,
      noteType: 1,
      textObject: { opNoteId: blockNoteId, noteText: encodeString2Base64(textArea) },
    };
    await this.runWebServiceRequest(body, '/RegionalAnesthesiaTemplate/Update', 'POST');
  }

  /** Port of ReUsableWebserviceUtils.getPhysicianOrderDetails (PhysicianOrdersConfiguration/names, GET). Caches physicianOrderId under Keys.KEY_PHYSICIAN_ORDER_ID. */
  protected async getPhysicianOrderDetails(name: string): Promise<boolean> {
    const response = await this.runWebServiceRequest('', 'PhysicianOrdersConfiguration/names', 'GET');
    const orders = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const order = findByField(orders as Record<string, unknown>[], 'name', name);
    if (!order) return false;
    this.responseCache.put(Keys.KEY_PHYSICIAN_ORDER_ID, order.physicianOrderId);
    return true;
  }

  /**
   * Port of ReUsableWebserviceUtils.mapDocumentationToPreferenceCards
   * (PreferenceCardConfig/InsertPreferenceConfig{PhysOrder,Opnotes,Consents,DiscConfig}Maps, POST x{0..4}).
   * Each of the 4 params, when non-blank, is ','-split and mapped in one POST per field-type.
   */
  protected async mapDocumentationToPreferenceCards(
    preferenceCardId: number,
    physicianOrder: string | undefined,
    opNote: string | undefined,
    consent: string | undefined,
    dischargeInstruction: string | undefined
  ): Promise<void> {
    if (!isBlank(physicianOrder)) {
      const maps: Record<string, unknown>[] = [];
      for (const name of physicianOrder!.split(',')) {
        const found = await this.getPhysicianOrderDetails(name);
        if (found) maps.push({ physicianOrderId: this.responseCache.get(Keys.KEY_PHYSICIAN_ORDER_ID), preferenceCardId });
      }
      await this.runWebServiceRequest(maps, 'PreferenceCardConfig/InsertPreferenceConfigPhysOrderMaps', 'POST');
    }
    if (!isBlank(opNote)) {
      const maps: Record<string, unknown>[] = [];
      for (const name of opNote!.split(',')) {
        const found = await this.getPhysicianOpNotesDetails(name);
        if (found) maps.push({ opnoteId: this.responseCache.get(Keys.KEY_PHYSICIAN_OP_NOTES_ID), preferenceCardId });
      }
      await this.runWebServiceRequest(maps, 'PreferenceCardConfig/InsertPreferenceConfigOpnotesMaps', 'POST');
    }
    if (!isBlank(consent)) {
      const maps: Record<string, unknown>[] = [];
      for (const name of consent!.split(',')) {
        const found = await this.getConsentDetails(name);
        if (found) maps.push({ consentConfigurationId: this.responseCache.get(Keys.KEY_CONSENTS_ID), preferenceCardId });
      }
      await this.runWebServiceRequest(maps, 'PreferenceCardConfig/InsertPreferenceConfigConsentsMaps', 'POST');
    }
    if (!isBlank(dischargeInstruction)) {
      const maps: Record<string, unknown>[] = [];
      for (const name of dischargeInstruction!.split(',')) {
        const found = await this.getDischargeInstrDetails(name);
        if (found) maps.push({ dischargeConfigurationId: this.responseCache.get(Keys.KEY_DISCHARGE_INSTR_CONFIGURATION_ID), preferenceCardId });
      }
      await this.runWebServiceRequest(maps, 'PreferenceCardConfig/InsertPreferenceConfigDiscConfigMaps', 'POST');
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.updateWorklistToPrefeCard (PreferenceCardConfig/UpsertPreferenceConfigWorklistMap, PUT).
   * Called once per worklist area/name pair - no internal multi-value splitting, matching the Java original.
   */
  protected async updateWorklistToPrefeCard(preferenceCardId: number, worklistArea: number, worklistName: string): Promise<void> {
    const found = await this.getWorklistDetails(worklistArea, worklistName);
    if (!found) return;
    const worklistId = Number(this.responseCache.get(Keys.KEY_WORKLIST_ID));
    await this.runWebServiceRequest({ worklistArea, worklistId, preferenceCardId }, 'PreferenceCardConfig/UpsertPreferenceConfigWorklistMap', 'PUT');
  }

  /**
   * Port of ReUsableWebserviceUtils.mapWorklistsToPreferenceCards. Fixed worklistArea codes per
   * department, matching the Java original: preAdmissionQx=1, preAdmissionInstructions=2,
   * preOperative=3, operative=4, phase1=5, phase2=6, recovery=7, phase3=8, postoperativeQX=9.
   */
  protected async mapWorklistsToPreferenceCards(
    preferenceCardId: number,
    preAdmissionQxWorklist: string | undefined,
    preAdmissionInstructionsWorklist: string | undefined,
    preOperativeWorklist: string | undefined,
    operativeWorklist: string | undefined,
    phase1Worklist: string | undefined,
    phase2Worklist: string | undefined,
    phase3Worklist: string | undefined,
    recoveryWorklist: string | undefined,
    postoperativeQXWorklist: string | undefined
  ): Promise<void> {
    const areas: [string | undefined, number][] = [
      [preAdmissionQxWorklist, 1],
      [preAdmissionInstructionsWorklist, 2],
      [preOperativeWorklist, 3],
      [operativeWorklist, 4],
      [phase1Worklist, 5],
      [phase2Worklist, 6],
      [recoveryWorklist, 7],
      [phase3Worklist, 8],
      [postoperativeQXWorklist, 9],
    ];
    for (const [worklistName, area] of areas) {
      if (!isBlank(worklistName)) {
        await this.updateWorklistToPrefeCard(preferenceCardId, area, worklistName!);
      }
    }
  }

  /** Port of ReUsableWebserviceUtils.getImplantDetails (Inventory/SearchExtended?category=Implant, GET). Matched by items[].name containment. */
  protected async getImplantDetails(implantName: string): Promise<boolean> {
    const response = await this.runWebServiceRequest('', `Inventory/SearchExtended?searchText=${encodeURIComponent(implantName)}&category=Implant&searchType=0`, 'GET');
    const parsed = typeof response.data === 'object' && response.data !== null ? response.data : response.raw ? JSON.parse(response.raw) : {};
    const items = (parsed as Record<string, unknown>).items as Record<string, unknown>[];
    const item = items?.find((i) => String(i.name).includes(implantName));
    if (!item) return false;
    this.responseCache.put(Keys.KEY_IMPLANT_ID, item.itemNumber);
    this.responseCache.put(Keys.KEY_IMPLANT_EXTERNAL_ID, item.externalItemId);
    return true;
  }

  /**
   * Port of ReUsableWebserviceUtils.mapImplantToPreferenceCard (PreferenceCardConfig/ImplantProsthesis, PUT).
   * implantName is ','-separated; each implant is POSTed independently (one PUT per implant).
   */
  protected async mapImplantToPreferenceCard(
    preferenceCardId: number,
    implantName: string | undefined,
    manfacturerName: string | undefined,
    size: string | undefined,
    lotNum: string | undefined,
    serialNum: string | undefined,
    expiration: string | undefined,
    referenceNum: string | undefined,
    quantity: string | undefined,
    notes: string | undefined
  ): Promise<void> {
    if (isBlank(implantName)) return;
    const implantNames = implantName!.split(',');
    const manufacturerNames = manfacturerName?.split(',') ?? [];
    const sizes = size?.split(',') ?? [];
    const lotNums = lotNum?.split(',') ?? [];
    const serialNums = serialNum?.split(',') ?? [];
    const expirations = expiration?.split(',') ?? [];
    const referenceNums = referenceNum?.split(',') ?? [];
    const quantities = quantity?.split(',') ?? [];
    const notesList = notes?.split(',') ?? [];

    for (let i = 0; i < implantNames.length; i++) {
      const found = await this.getImplantDetails(implantNames[i]);
      if (!found) continue;

      let body = this.templates.load<Record<string, unknown>>('ImplantToPrefCard.json');
      body = updateField(body, 'preferenceCardId', preferenceCardId);
      body = updateField(body, 'implantName', encodeString2Base64(implantNames[i]));
      body = updateField(body, 'inventoryNumber', encodeString2Base64(String(this.responseCache.get(Keys.KEY_IMPLANT_ID))));
      body = updateField(body, 'manufacturerName', encodeString2Base64(manufacturerNames[i] ?? ''));
      if (!isBlank(quantities[i])) body = updateField(body, 'quantity', quantities[i]);
      if (!isBlank(sizes[i])) body = updateField(body, 'size', encodeString2Base64(sizes[i]));
      if (!isBlank(lotNums[i])) body = updateField(body, 'lotNum', encodeString2Base64(lotNums[i]));
      if (!isBlank(serialNums[i])) body = updateField(body, 'serialNum', encodeString2Base64(serialNums[i]));
      if (!isBlank(expirations[i])) body = updateField(body, 'expiration', encodeString2Base64(expirations[i]));
      if (!isBlank(referenceNums[i])) body = updateField(body, 'referenceNum', encodeString2Base64(referenceNums[i]));
      if (!isBlank(notesList[i])) body = updateField(body, 'notes', encodeString2Base64(notesList[i]));

      await this.runWebServiceRequest(body, 'PreferenceCardConfig/ImplantProsthesis', 'PUT');
    }
  }

  /** Port of ReUsableWebserviceUtils.getSupplyDetails (Inventory/SearchExtended?category=Supply/Instrument, GET). Matched by items[].name containment. */
  protected async getSupplyDetails(supplyName: string): Promise<boolean> {
    const response = await this.runWebServiceRequest('', `Inventory/SearchExtended?searchText=${encodeURIComponent(supplyName)}&category=Supply/Instrument&searchType=0`, 'GET');
    const parsed = typeof response.data === 'object' && response.data !== null ? response.data : response.raw ? JSON.parse(response.raw) : {};
    const items = (parsed as Record<string, unknown>).items as Record<string, unknown>[];
    const item = items?.find((i) => String(i.name).includes(supplyName));
    if (!item) return false;
    this.responseCache.put(Keys.KEY_SUPPLY_ID, item.itemNumber);
    this.responseCache.put(Keys.KEY_SUPPLY_EXTERNAL_ID, item.externalItemId);
    return true;
  }

  /**
   * Port of ReUsableWebserviceUtils.mapSuppliesToPreferenceCard (PreferenceCardConfig/SuppliesSingle, PUT).
   * Preserves a known Java quirk: `supplyObj` is built once outside the per-supply loop and only
   * the LAST supply's data is actually POSTed when supplyName has multiple ','-separated entries -
   * this is a latent bug in the Java original, kept as-is for parity rather than silently fixed.
   * Also preserves: phase1/phase2/phase3 (non-recovery) open/hold quantities are never sent -
   * that branch is commented out ("TODO: handle exception") in the Java source.
   */
  protected async mapSuppliesToPreferenceCard(
    preferenceCardId: number,
    supplyName: string | undefined,
    prOpen: string | undefined,
    prHold: string | undefined,
    orOpen: string | undefined,
    orHold: string | undefined,
    p3Open: string | undefined,
    p3Hold: string | undefined,
    notes: string | undefined
  ): Promise<void> {
    if (isBlank(supplyName)) return;
    const supplyNames = supplyName!.split(',');
    const notesList = notes?.split(',') ?? [];

    const recoveryFlag = (p3Hold?.split('|')[0] ?? '').toLowerCase() === 'recovery' && (p3Open?.split('|')[0] ?? '').toLowerCase() === 'recovery';
    const p3OpenValue = recoveryFlag ? p3Open?.split('|')[1] : p3Open;
    const p3HoldValue = recoveryFlag ? p3Hold?.split('|')[1] : p3Hold;

    let supplyObj: Record<string, unknown> = {};
    for (let i = 0; i < supplyNames.length; i++) {
      const found = await this.getSupplyDetails(supplyNames[i]);
      if (!found) continue;

      supplyObj = {
        isKeySearchEnabled: true,
        isReplaceKeySearchEnabled: true,
        preferenceCardId,
        supplyName: encodeString2Base64(supplyNames[i]),
        revenueCode: null,
        billable: true,
        externalIdentifier: this.responseCache.get(Keys.KEY_SUPPLY_EXTERNAL_ID),
        inventoryNumber: encodeString2Base64(String(this.responseCache.get(Keys.KEY_SUPPLY_ID))),
        sortOrder: i,
      };
      if (!isBlank(notesList[i])) supplyObj.notes = encodeString2Base64(notesList[i]);

      const quantities: Record<string, unknown>[] = [];
      if (!isBlank(prOpen)) quantities.push({ areaOfCareId: 1020, pROpen: prOpen, open: prOpen });
      if (!isBlank(prHold)) quantities.push({ areaOfCareId: 1020, pRHold: prHold, hold: prHold });
      if (!isBlank(orOpen)) quantities.push({ areaOfCareId: 1030, oROpen: orOpen, open: orOpen });
      if (!isBlank(orHold)) quantities.push({ areaOfCareId: 1030, oRHold: orHold, hold: orHold });
      if (recoveryFlag) {
        if (!isBlank(p3OpenValue)) quantities.push({ areaOfCareId: 1060, rCOpen: p3OpenValue, open: p3OpenValue });
        if (!isBlank(p3HoldValue)) quantities.push({ areaOfCareId: 1060, rCHold: p3HoldValue, hold: p3HoldValue });
      }
      supplyObj.quantities = quantities;
    }

    if (Object.keys(supplyObj).length > 0) {
      await this.runWebServiceRequest(supplyObj, 'PreferenceCardConfig/SuppliesSingle', 'PUT');
    }
  }

  /** Port of ReUsableWebserviceUtils.getEquipmentDetailsFromConfig (Equipment/GetEquipments/true, GET). Matched by equipmentName. */
  protected async getEquipmentDetailsFromConfig(equipmentName: string): Promise<boolean> {
    const response = await this.runWebServiceRequest('', 'Equipment/GetEquipments/true', 'GET');
    const equipmentList = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const equipment = findByField(equipmentList as Record<string, unknown>[], 'equipmentName', equipmentName);
    if (!equipment) return false;
    this.responseCache.put(Keys.KEY_EQUIPMENT_ID, equipment.equipmentConfigId);
    return true;
  }

  /**
   * Port of ReUsableWebserviceUtils.mapEquipmentToPreferenceCard (PreferenceCardConfig/EquipmentSingle, POST).
   * equipmentName is ','-separated; each equipment item is POSTed independently.
   */
  protected async mapEquipmentToPreferenceCard(
    preferenceCardId: number,
    equipmentName: string | undefined,
    serialNumber: string | undefined,
    notes: string | undefined
  ): Promise<void> {
    if (isBlank(equipmentName)) return;
    const equipmentNames = equipmentName!.split(',');
    const serialNumbers = serialNumber?.split(',') ?? [];
    const notesList = notes?.split(',') ?? [];

    for (let i = 0; i < equipmentNames.length; i++) {
      const found = await this.getEquipmentDetailsFromConfig(equipmentNames[i]);
      if (!found) continue;

      const body: Record<string, unknown> = {
        equipmentName: encodeString2Base64(equipmentNames[i]),
        isKeySearchEnabled: true,
        equipmentConfigId: this.responseCache.get(Keys.KEY_EQUIPMENT_ID),
        sortOrder: i,
        isDisabled: true,
        preferenceCardId,
      };
      if (!isBlank(notesList[i])) body.notes = encodeString2Base64(notesList[i]);
      if (!isBlank(serialNumbers[i])) body.serialNumber = encodeString2Base64(serialNumbers[i]);

      await this.runWebServiceRequest(body, 'PreferenceCardConfig/EquipmentSingle', 'POST');
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.InsertPreferenceConfigFeeScheduelMap (PreferenceCardConfig/InsertPreferenceConfigFeeScheduelMap, POST).
   * Preserves a Java quirk: the array item's cptCode field uses the whole unsplit cptCode
   * string, not the per-index split value - kept as-is for parity.
   */
  protected async insertPreferenceConfigFeeScheduelMap(preferenceCardId: number, cptCode: string): Promise<void> {
    const codes = cptCode.split(',');
    const items: Record<string, unknown>[] = [];
    for (let i = 0; i < codes.length; i++) {
      const feeSchedules = await this.getAllFeeSchedules();
      const feeSchedule = feeSchedules.find(
        (fs) => String((fs.cptProcedure as Record<string, unknown> | undefined)?.cptCode).toLowerCase() === codes[i].toLowerCase()
      );
      if (!feeSchedule) continue;
      items.push({
        cptCode,
        preferenceCardId,
        feeScheduleId: feeSchedule.feeScheduleId,
        feeScheduleRootId: feeSchedule.feeScheduleId,
        displayOrder: i + 1,
      });
    }
    await this.runWebServiceRequest(items, 'PreferenceCardConfig/InsertPreferenceConfigFeeScheduelMap', 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.addPreferenceCard. Skip-if-exists: matching Java, an
   * already-present card's sub-entities (documentation/worklists/implants/supplies/equipment/
   * fee-schedule) are NOT re-applied - only its cached preferenceCardId is returned.
   */
  protected async addPreferenceCard(
    preferenceCardName: string,
    caseSpecialtiy: string | undefined,
    appointmentTypeValue: string | undefined,
    physician: string | undefined,
    anesthesiaTypeValue: string | undefined,
    caseFlags: string | undefined,
    physicianOrder: string | undefined,
    opNote: string | undefined,
    consent: string | undefined,
    dischargeInstruction: string | undefined,
    preAdmissionQxWorklist: string | undefined,
    preAdmissionInstructionsWorklist: string | undefined,
    preOperativeWorklist: string | undefined,
    operativeWorklist: string | undefined,
    phase1Worklist: string | undefined,
    phase2Worklist: string | undefined,
    phase3Worklist: string | undefined,
    recoveryWorklist: string | undefined,
    postoperativeQXWorklist: string | undefined,
    implantName: string | undefined,
    manfacturerName: string | undefined,
    size: string | undefined,
    lotNum: string | undefined,
    serialNum: string | undefined,
    expiration: string | undefined,
    referenceNum: string | undefined,
    quantity: string | undefined,
    implantNotes: string | undefined,
    supplyName: string | undefined,
    prOpen: string | undefined,
    prHold: string | undefined,
    orOpen: string | undefined,
    orHold: string | undefined,
    p3Open: string | undefined,
    p3Hold: string | undefined,
    supplyNotes: string | undefined,
    equipmentName: string | undefined,
    serialNumber: string | undefined,
    equipmentNotes: string | undefined,
    cptCodes: string | undefined
  ): Promise<number> {
    const alreadyPresent = await this.isPreferenceCardPresent(preferenceCardName);
    if (alreadyPresent) {
      return Number(this.responseCache.get(Keys.KEY_PREFERENCE_CARD_ID));
    }

    const createResponse = await this.runWebServiceRequest({ preferenceCardName }, 'PreferenceCardConfig/UpsertPreferenceCardConfig', 'PUT');
    let prefCardId = Number(JSON.parse(createResponse.raw).preferenceCardId);

    const prefCardObject: Record<string, unknown> = {
      preferenceCardName,
      preferenceCardId: prefCardId,
      organizationId: Number(this.responseCache.getString(Keys.KEY_ORG_ID)),
    };

    if (!isBlank(physician)) {
      const [, , personId] = await this.getPhysicianNameIDFromPhysicianName(physician!);
      prefCardObject.physicianId = Number(personId);
    }
    if (!isBlank(caseSpecialtiy)) {
      prefCardObject.caseSpecialtyName = caseSpecialtiy;
      const casePack = await this.getCaseDetails(caseSpecialtiy!);
      if (casePack) prefCardObject.caseSpecialtyId = casePack.casePackId;
    }
    if (!isBlank(anesthesiaTypeValue)) {
      prefCardObject.anesthesiaTypeName = anesthesiaTypeValue;
      const found = await this.getDictionaryDetails('Anesthesia Type', anesthesiaTypeValue!);
      if (found) prefCardObject.anesthesiaTypeId = this.responseCache.get(Keys.KEY_DICTIONARY_ITEM_ID);
    }
    if (!isBlank(appointmentTypeValue)) {
      prefCardObject['Appointment Type'] = appointmentTypeValue;
      const found = await this.getDictionaryDetails('Appointment Type', appointmentTypeValue!);
      if (found) prefCardObject.appointmentTypeId = this.responseCache.get(Keys.KEY_DICTIONARY_ITEM_ID);
    }
    if (!isBlank(caseFlags)) {
      const preferenceCardCaseFlagMapList: Record<string, unknown>[] = [];
      for (const flagName of caseFlags!.split('|')) {
        const caseFlag = await this.getCaseFlagDetails(flagName);
        preferenceCardCaseFlagMapList.push({ caseFlagId: caseFlag.caseFlagId, preferenceCardId: prefCardId });
      }
      prefCardObject.preferenceCardCaseFlagMapList = preferenceCardCaseFlagMapList;
    }

    const updateResponse = await this.runWebServiceRequest(prefCardObject, 'PreferenceCardConfig/UpsertPreferenceCardConfig', 'PUT');
    prefCardId = Number(JSON.parse(updateResponse.raw).preferenceCardId);

    await this.mapDocumentationToPreferenceCards(prefCardId, physicianOrder, opNote, consent, dischargeInstruction);
    await this.mapWorklistsToPreferenceCards(
      prefCardId,
      preAdmissionQxWorklist,
      preAdmissionInstructionsWorklist,
      preOperativeWorklist,
      operativeWorklist,
      phase1Worklist,
      phase2Worklist,
      phase3Worklist,
      recoveryWorklist,
      postoperativeQXWorklist
    );
    await this.mapImplantToPreferenceCard(prefCardId, implantName, manfacturerName, size, lotNum, serialNum, expiration, referenceNum, quantity, implantNotes);
    await this.mapSuppliesToPreferenceCard(prefCardId, supplyName, prOpen, prHold, orOpen, orHold, p3Open, p3Hold, supplyNotes);
    await this.mapEquipmentToPreferenceCard(prefCardId, equipmentName, serialNumber, equipmentNotes);
    if (!isBlank(cptCodes)) {
      await this.insertPreferenceConfigFeeScheduelMap(prefCardId, cptCodes!);
    }

    return prefCardId;
  }

  /** Port of ReUsableWebserviceUtils.getTitratedDrugs (FDB/GetDrugNames, POST). Matched by drugNameDesc. */
  protected async getTitratedDrugs(searchString: string): Promise<Record<string, unknown>> {
    const response = await this.runWebServiceRequest(
      { searchText: searchString.slice(0, 4), searchType: 1, offset: 1, limit: 100 },
      'FDB/GetDrugNames',
      'POST'
    );
    const parsed = JSON.parse(response.raw);
    const items = parsed.items as Record<string, unknown>[];
    const drug = findByField(items, 'drugNameDesc', searchString);
    if (!drug) {
      throw new Error(`getTitratedDrugs: no drug found with drugNameDesc "${searchString}"`);
    }
    return drug;
  }

  /** Port of ReUsableWebserviceUtils.getDispensableDrugNames (FDB/GetDispensableDrugNamesByDrugId, POST). Matched by dispensableDrugDesc. */
  protected async getDispensableDrugNames(drugNameId: number, fullMedication: string): Promise<Record<string, unknown>> {
    const response = await this.runWebServiceRequest({ offset: 1, limit: 100, drugNameId }, 'FDB/GetDispensableDrugNamesByDrugId', 'POST');
    const parsed = JSON.parse(response.raw);
    const items = parsed.items as Record<string, unknown>[];
    const drug = findByField(items, 'dispensableDrugDesc', fullMedication);
    if (!drug) {
      throw new Error(`getDispensableDrugNames: no dispensable drug found with dispensableDrugDesc "${fullMedication}"`);
    }
    return drug;
  }

  /** Port of ReUsableWebserviceUtils.getAnesthesiaModulesForOrganization (Module/GetAnesthesiaModulesForOrganization/true, GET). */
  protected async getAnesthesiaModulesForOrganization(): Promise<Record<string, unknown>[]> {
    const response = await this.runWebServiceRequest('', 'Module/GetAnesthesiaModulesForOrganization/true', 'GET');
    return Array.isArray(response.data) ? (response.data as Record<string, unknown>[]) : JSON.parse(response.raw);
  }

  /** Port of ReUsableWebserviceUtils.getCaseDetails (CasePack/GetCasePacks, GET). Matched by casePackName. */
  protected async getCaseDetails(casePackName: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.runWebServiceRequest('', 'CasePack/GetCasePacks', 'GET');
    const casePacks = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    return (casePacks as Record<string, unknown>[]).find((c) => String(c.casePackName).toLowerCase() === casePackName.toLowerCase());
  }

  /** Port of ReUsableWebserviceUtils.insertMedicationTemplate (MedicationTemplate/Insert/false, POST). */
  protected async insertMedicationTemplate(body: Record<string, unknown>): Promise<void> {
    await this.runWebServiceRequest(body, 'MedicationTemplate/Insert/false', 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.getMedicationObject (plain/"NA" medication path only -
   * compound and titrated paths are not ported; see createMedication in webServiceClient.ts).
   * Builds the medicationTemplate.json body from the resolved drug/dispensable-drug objects,
   * plus optional department/speciality module and case-pack mappings.
   */
  protected async getMedicationObject(
    titratedDrug: Record<string, unknown>,
    dispensableDrugObject: Record<string, unknown>,
    department: string | undefined,
    speciality: string | undefined,
    templateName: string
  ): Promise<Record<string, unknown>> {
    let body = this.templates.load<Record<string, unknown>>('medicationTemplate.json');
    body = updateField(body, 'compoundTf', false);
    body = updateField(body, 'titratedTf', false);
    body = updateField(body, 'templateName', templateName);
    body = updateField(body, 'medication', dispensableDrugObject.dispensableDrugDesc);
    body = updateField(body, 'dispensableDrugId', dispensableDrugObject.dispensableDrugID);
    body = updateField(body, 'defaultETCID', titratedDrug.defaultETCID ?? null);
    body = updateField(body, 'defaultETCDesc', titratedDrug.defaultETCDesc ?? null);

    const selectedDispensableDrug: Record<string, unknown> = {
      dispensableDrugID: dispensableDrugObject.dispensableDrugID,
      dispensableDrugDesc: dispensableDrugObject.dispensableDrugDesc,
      dispensableGenericID: dispensableDrugObject.dispensableGenericID,
      dispensableGenericDesc: dispensableDrugObject.dispensableGenericDesc,
      routeID: dispensableDrugObject.routeID,
      routeDesc: dispensableDrugObject.routeDesc,
      medStrength: dispensableDrugObject.medStrength,
      medStrengthUnit: dispensableDrugObject.medStrengthUnit,
      doseFormID: dispensableDrugObject.doseFormID,
      doseFormDesc: dispensableDrugObject.doseFormDesc,
      drugNameID: titratedDrug.drugNameID,
      drugNameDesc: titratedDrug.drugNameDesc,
      nameTypeCode: titratedDrug.nameTypeCode,
      nameTypeCodeDesc: titratedDrug.nameTypeCodeDesc,
      statusCode: titratedDrug.statusCode,
      statusCodeDesc: titratedDrug.statusCodeDesc,
      defaultETCID: titratedDrug.defaultETCID ?? null,
      defaultETCDesc: titratedDrug.defaultETCDesc ?? null,
    };
    body = updateField(body, 'selectedDispensableDrug', selectedDispensableDrug);

    if (!isBlank(department)) {
      const modules = await this.getAnesthesiaModulesForOrganization();
      const moduleNames = department!.includes(';') ? department!.split(';') : [department!];
      const moduleMapList = moduleNames
        .map((name) => findByField(modules, 'moduleName', name))
        .filter((m): m is Record<string, unknown> => !!m)
        .map((m) => ({ moduleId: m.moduleId }));
      body = updateField(body, 'medicationTemplateModuleMapList', moduleMapList);
    }

    if (!isBlank(speciality)) {
      const specialityNames = speciality!.includes(';') ? speciality!.split(';') : [speciality!];
      const casePackMapList: Record<string, unknown>[] = [];
      for (const name of specialityNames) {
        const casePack = await this.getCaseDetails(name);
        if (casePack) casePackMapList.push({ casePackId: casePack.casePackId });
      }
      body = updateField(body, 'medicationTemplateCasePackMapList', casePackMapList);
    }

    return body;
  }

  /** Port of ReUsableWebserviceUtils.getCaseFlagColors (/CaseFlag/Colors, GET). Matched by name. */
  protected async getCaseFlagColors(color: string): Promise<Record<string, unknown>> {
    const response = await this.runWebServiceRequest('', '/CaseFlag/Colors', 'GET');
    const colors = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const colorObj = findByField(colors as Record<string, unknown>[], 'name', color);
    if (!colorObj) {
      throw new Error(`getCaseFlagColors: no color found with name "${color}"`);
    }
    return colorObj;
  }

  /** Port of ReUsableWebserviceUtils.performCaseFlagLock (Security/RecordLock/RequestLock or ReleaseLock, POST). recordLockTypeId 27 matches the Java original. */
  protected async performCaseFlagLock(requestLock: boolean): Promise<void> {
    const orgId = Number(this.responseCache.getString(Keys.KEY_ORG_ID));
    const endpoint = requestLock ? 'Security/RecordLock/RequestLock' : 'Security/RecordLock/ReleaseLock';
    await this.runWebServiceRequest({ recordLockTypeId: 27, organizationId: orgId }, endpoint, 'POST');
  }

  /** Port of WebServiceClient.getWriteOffGroupList (StaticList/GetWriteOffGroupList, GET). Matched by writeOffGroupCode. */
  protected async getWriteOffGroupId(writeOffGroupCode: string): Promise<number | undefined> {
    const response = await this.runWebServiceRequest('', 'StaticList/GetWriteOffGroupList', 'GET');
    const groups = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const group = findByField(groups as Record<string, unknown>[], 'writeOffGroupCode', writeOffGroupCode);
    return group ? Number(group.writeOffGroupId) : undefined;
  }

  /** Port of WebServiceClient.getWriteOffReasonList (StaticList/GetWriteOffReasonList, GET). Matched by writeOffReasonCode. */
  protected async getWriteOffReasonId(writeOffReasonCode: string): Promise<number | undefined> {
    const response = await this.runWebServiceRequest('', 'StaticList/GetWriteOffReasonList', 'GET');
    const reasons = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const reason = findByField(reasons as Record<string, unknown>[], 'writeOffReasonCode', writeOffReasonCode);
    return reason ? Number(reason.writeOffReasonId) : undefined;
  }

  /**
   * Port of WebServiceClient.getTransactionCodeListByType (TransactionCode/GetTransactionCodeListByType/4, GET).
   * Type id 4 is hardcoded, matching the Java original. Matched by transactionCodeName.
   */
  protected async getTransactionCodeIdByType(transactionCodeName: string): Promise<number | undefined> {
    const response = await this.runWebServiceRequest('', 'TransactionCode/GetTransactionCodeListByType/4', 'GET');
    const codes = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const code = findByField(codes as Record<string, unknown>[], 'transactionCodeName', transactionCodeName);
    return code ? Number(code.transactionCodeId) : undefined;
  }

  /**
   * Port of ReUsableWebserviceUtils.createSaveSourceOfRevenue (SourceOfRevenue/SaveSourceOfRevenue, PUT x2).
   * Skip-if-exists: no-ops if a discount with this name is already present (matching Java).
   */
  protected async createSaveSourceOfRevenue(
    discountName: string,
    writeOffGroupCode: string,
    writeOffReasonCode: string,
    transactionCodeName: string,
    discountpercent: string
  ): Promise<void> {
    const alreadyPresent = await this.getDiscountDetails(discountName);
    if (alreadyPresent) return;

    const createResponse = await this.runWebServiceRequest({ sourceOfRevenueName: discountName }, 'SourceOfRevenue/SaveSourceOfRevenue', 'PUT');
    const discount = JSON.parse(createResponse.raw);

    if (!isBlank(writeOffGroupCode)) {
      discount.writeoffGroupId = await this.getWriteOffGroupId(writeOffGroupCode);
    }
    if (!isBlank(writeOffReasonCode)) {
      discount.writeoffReasonId = await this.getWriteOffReasonId(writeOffReasonCode);
    }
    if (!isBlank(transactionCodeName)) {
      discount.transactionCodeId = await this.getTransactionCodeIdByType(transactionCodeName);
    }
    discount.discountPercent = Number(discountpercent);

    await this.runWebServiceRequest(discount, 'SourceOfRevenue/SaveSourceOfRevenue', 'PUT');
  }

  /** Port of ReUsableWebserviceUtils.getDiscountDetails (/SourceOfRevenue/GetSourceOfRevenueList, GET). Caches sourceOfRevenueId under Keys.KEY_DISCOUNT_ID. */
  protected async getDiscountDetails(discountName: string): Promise<boolean> {
    const response = await this.runWebServiceRequest('', '/SourceOfRevenue/GetSourceOfRevenueList', 'GET');
    const revenues = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const revenue = (revenues as Record<string, unknown>[]).find((r) => String(r.sourceOfRevenueName).toLowerCase() === discountName.toLowerCase());
    if (!revenue) return false;
    this.responseCache.put(Keys.KEY_DISCOUNT_ID, revenue.sourceOfRevenueId);
    return true;
  }

  /** Pure lookup, no API call - port of WebServiceClient.getContractType. */
  private getContractType(contractType: string): number {
    const normalized = contractType.toLowerCase();
    if (normalized === 'grouper') return 1;
    if (normalized === 'contract fee schedule') return 2;
    if (normalized === '% of billed charges') return 3;
    return 0;
  }

  /**
   * Port of WebServiceClient.saveContract (PUT InsuranceContract/SaveInsuranceContract).
   * Caches the new insuranceContractId under Keys.KEY_INSURANCE_CONTRACT_ID.
   */
  protected async saveContract(insuranceContractName: string, effectiveDate: string, expirationDate: string, contractType: string): Promise<void> {
    const body = {
      insuranceContractName,
      effectiveDate: addDate(effectiveDate, 'yyyy-MM-dd'),
      expirationDate: addDate(expirationDate, 'yyyy-MM-dd'),
      contractType: this.getContractType(contractType),
    };
    const response = await this.runWebServiceRequest(body, 'InsuranceContract/SaveInsuranceContract', 'PUT');
    const parsed = JSON.parse(response.raw);

    // Under concurrent load, two rows can both see "contract doesn't exist yet" and both try to
    // create it - the "losing" request's response doesn't carry a usable insuranceContractId. Rather
    // than crash, fall back to looking the contract up by name (the winner's write should be visible
    // by now, or shortly after via pollUntilFound) and use that ID instead.
    const insuranceContractId =
      parsed?.insuranceContractId ??
      (await this.pollUntilFound(() => this.retrieveContracts(insuranceContractName)))?.insuranceContractId;

    if (insuranceContractId == null) {
      throw new Error(`saveContract: no insuranceContractId returned or found for "${insuranceContractName}"`);
    }
    this.responseCache.put(Keys.KEY_INSURANCE_CONTRACT_ID, insuranceContractId);
  }

  /**
   * Port of WebServiceClient.SelectContractOptions (PUT InsuranceContract/SaveInsuranceContractPostingOption).
   * percentOfBilledCharge is only set for non-Grouper contract types, matching the Java original.
   */
  protected async selectContractOptions(
    contractType: string,
    percentOfBilledCharge: string,
    transactionCodeName: string,
    writeOffGroupId: string,
    writeOffReasonId: string
  ): Promise<void> {
    let body = this.templates.load<Record<string, unknown>>('AddContractPostingOption.json');
    body = updateField(body, 'insuranceContractId', Number(this.responseCache.get(Keys.KEY_INSURANCE_CONTRACT_ID)));

    if (contractType.toLowerCase() !== 'grouper') {
      body = updateField(body, 'percentOfBilledCharge', Number(percentOfBilledCharge));
    }
    if (!isBlank(writeOffGroupId)) {
      body = updateField(body, 'writeOffGroupId', await this.getWriteOffGroupId(writeOffGroupId));
    }
    if (!isBlank(writeOffReasonId)) {
      body = updateField(body, 'writeOffReasonId', await this.getWriteOffReasonId(writeOffReasonId));
    }
    if (!isBlank(transactionCodeName)) {
      body = updateField(body, 'transactionCodeId', await this.getTransactionCodeIdByType(transactionCodeName));
    }

    await this.runWebServiceRequestWithRetryOnTransientFailure(body, 'InsuranceContract/SaveInsuranceContractPostingOption', 'PUT');
  }

  /**
   * Port of WebServiceClient.updateFeeGroupsForGrouperContract (PUT InsuranceContract/SaveInsuranceContractFeeGroup).
   * Only called for Grouper-type contracts. groupIndx/reimbursement are ','-separated per group.
   */
  protected async updateFeeGroupsForGrouperContract(groupIndx: string, reimbursement: string): Promise<void> {
    const insuranceContractId = Number(this.responseCache.get(Keys.KEY_INSURANCE_CONTRACT_ID));
    const groupIndexes = groupIndx.split(',');
    const reimbursements = reimbursement.split(',');
    for (let i = 0; i < groupIndexes.length; i++) {
      const grpIndx = groupIndexes[i];
      if (isBlank(grpIndx)) continue;
      await this.runWebServiceRequest(
        { insuranceContractId, groupIdx: Number(grpIndx), reimbursement: Number(reimbursements[i]), isSelected: true },
        'InsuranceContract/SaveInsuranceContractFeeGroup',
        'PUT'
      );
    }
  }

  /**
   * Port of WebServiceClient.selectProcedureDiscount (PUT InsuranceContract/SaveInsuranceContractProcedure).
   * Called once per non-blank procedure field by saveMultipleProceduresForContracts, sortIndex fixed 1-6.
   */
  protected async selectProcedureDiscount(discountName: string, procedureIndex: number): Promise<void> {
    await this.getDiscountDetails(discountName);
    const body = {
      sortIndex: procedureIndex,
      discountId: Number(this.responseCache.get(Keys.KEY_DISCOUNT_ID)),
      insuranceContractId: Number(this.responseCache.get(Keys.KEY_INSURANCE_CONTRACT_ID)),
    };
    await this.runWebServiceRequest(body, 'InsuranceContract/SaveInsuranceContractProcedure', 'PUT');
  }

  /**
   * Port of ReUsableWebserviceUtils.saveInsurancePlan (InsurancePlan/SaveInsurancePlan, PUT).
   * contractName, when non-blank, is a ','-separated list of contract names each
   * resolved via retrieveContracts and mapped into insurancePlanContractList/selectedContracts.
   */
  protected async saveInsurancePlan(
    insuranceCarrierId: string,
    insurancePlanId: string | null,
    planName: string,
    insuranceClassification: string,
    officeName: string,
    line1: string,
    city: string,
    contactName: string,
    phone: string,
    zip: string,
    extendedZip: string,
    state: string,
    generateTrue: boolean,
    contractName: string | undefined
  ): Promise<WebServiceCallResult> {
    let body = this.templates.load<Record<string, unknown>>('SaveInsurancePlan.json');
    body = updateField(body, 'insuranceCarrierId', insuranceCarrierId);
    if (insurancePlanId) {
      body = updateField(body, 'insurancePlanId', Number(insurancePlanId));
    } else {
      delete body.insurancePlanId;
    }
    body = updateField(body, 'planName', planName);
    body = updateField(body, 'classification', insuranceClassification);
    body = updateField(body, 'claimOfficeName', officeName);
    body = updateField(body, 'generateClaimTf', generateTrue);
    body = updateField(body, 'address1', line1);
    body = updateField(body, 'city', city);
    body = updateField(body, 'contactName', contactName);
    body = updateField(body, 'phoneNumber', phone);
    body = updateField(body, 'zip', zip);
    body = updateField(body, 'extendedZipCode', extendedZip);
    body = updateField(body, 'state', state);

    const claimOfficeId = this.responseCache.get(Keys.KEY_INSURANCE_CLAIM_OFFICE_ID);
    if (claimOfficeId != null) {
      body = updateField(body, 'claimOfficeId', Number(claimOfficeId));
    }

    if (contractName != null && contractName.trim() !== '' && contractName.trim().toLowerCase() !== 'blank') {
      const insurancePlanContractList: Record<string, unknown>[] = [];
      const selectedContracts: Record<string, unknown>[] = [];
      const contractNames = contractName.split(',');

      for (let i = 0; i < contractNames.length; i++) {
        const contrName = contractNames[i];
        const contractDetails = await this.retrieveContracts(contrName);
        body = updateField(body, 'contract', contrName);

        if (contractDetails) {
          body = updateField(body, 'insuranceContractId', Number(contractDetails.insuranceContractId));
          insurancePlanContractList.push({
            insurancePlanContractId: 0,
            insurancePlanId: Number(insurancePlanId),
            insuranceContractId: Number(contractDetails.insuranceContractId),
            insuranceContractName: contrName,
            sortOrder: i,
            isSelected: true,
          });
          selectedContracts.push({
            ...contractDetails,
            insuranceContractSelectedOrder: i + 1,
            insurancePlanContractId: 0,
            ...(insurancePlanId ? { insurancePlanId: Number(insurancePlanId) } : {}),
          });
        }
      }
      body = updateField(body, 'insurancePlanContractList', insurancePlanContractList);
      body = updateField(body, 'selectedContracts', selectedContracts);
    }

    const response = await this.runWebServiceRequest(body, 'InsurancePlan/SaveInsurancePlan', 'PUT');
    const parsed = JSON.parse(response.raw) as Record<string, unknown>;
    this.responseCache.put(Keys.KEY_INSURANCE_PLAN_ID, String(parsed.insurancePlanId));
    return response;
  }

  /** Port of ReUsableWebserviceUtils.getAllPeriods (PeriodBatch/GetPeriodBatch/false, GET). */
  protected async getAllPeriods(): Promise<WebServiceCallResult> {
    return this.runWebServiceRequest('', 'PeriodBatch/GetPeriodBatch/false', 'GET');
  }

  /** Port of ReUsableWebserviceUtils.getPeriodByName. */
  protected async getPeriodByName(periodName: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.getAllPeriods();
    const periods = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const period = findByField(periods as Record<string, unknown>[], 'periodName', periodName);
    if (period) this.responseCache.put(Keys.KEY_PERIOD, period);
    return period;
  }

  /** Port of ReUsableWebserviceUtils.getPeriodById. */
  protected async getPeriodById(periodId: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.getAllPeriods();
    const periods = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const period = (periods as Record<string, unknown>[]).find((p) => Number(p.periodId) === Number(periodId));
    if (period) this.responseCache.put(Keys.KEY_PERIOD, period);
    return period;
  }

  /** Port of ReUsableWebserviceUtils.getBatchForChargeEntry. */
  protected async getBatchForChargeEntry(periodName: string, batchName: string): Promise<Record<string, unknown> | undefined> {
    const period = await this.getPeriodByName(periodName);
    const batches = (period?.batches ?? []) as Record<string, unknown>[];
    const batch = batches.find((b) => String(b.batchDescription).toLowerCase() === batchName.toLowerCase());
    if (!batch) return undefined;
    batch.value = batch.batchId;
    batch.label = batch.batchDescription;
    return batch;
  }

  /**
   * Port of ReUsableWebserviceUtils.createPeriod (PeriodConfig/UpsertPeriodObject, POST).
   * Returns the existing periodId if a period with this name already exists,
   * otherwise creates one and returns the new periodId.
   */
  protected async createPeriod(
    userName: string,
    periodName: string,
    periodBeginDate: string,
    periodEndDate: string,
    isActive: boolean
  ): Promise<string | null> {
    const existingPeriod = await this.getPeriodByName(periodName);
    if (existingPeriod) {
      return String(existingPeriod.periodId);
    }

    const [, , physicianId] = await this.getPhysicianNameIDFromPhysicianName(userName);

    let body = this.templates.load<Record<string, unknown>>('AddPeriod.json');
    body = updateField(body, 'periodCreatorUsrId', Number(physicianId));
    body = updateField(body, 'periodName', periodName);
    body = updateField(body, 'periodBeginDate', `${periodBeginDate}T12:50:00-0500`);
    body = updateField(body, 'periodEndDate', `${periodEndDate}T12:50:00-0500`);
    body = updateField(body, 'isActive', isActive);

    const response = await this.runWebServiceRequest(body, 'PeriodConfig/UpsertPeriodObject', 'POST');
    const parsed = JSON.parse(response.raw) as Record<string, unknown> | null;
    if (parsed?.periodId != null) {
      return String(parsed.periodId);
    }

    // A concurrent row may have created the same-named period between our
    // getPeriodByName check and this insert, causing the server to return an
    // empty body instead of the new period - re-check before failing.
    const raced = await this.getPeriodByName(periodName);
    if (raced) {
      return String(raced.periodId);
    }
    throw new Error(`createPeriod: UpsertPeriodObject returned no period for periodName="${periodName}"`);
  }

  /**
   * Port of ReUsableWebserviceUtils.createBatch (PeriodBatch/InsertBatch, POST).
   * No-ops (returns null) if a batch with this description already exists for
   * the period, matching the Java original's duplicate check.
   */
  protected async createBatch(userName: string, periodId: string, batchName: string): Promise<WebServiceCallResult | null> {
    const [, , physicianId] = await this.getPhysicianNameIDFromPhysicianName(userName);

    const period = await this.getPeriodById(periodId);
    const periodName = String(period?.periodName);
    const existingBatch = await this.getBatchForChargeEntry(periodName, batchName);
    if (existingBatch) return null;

    let body = this.templates.load<Record<string, unknown>>('InsertBatch.json');
    body = updateField(body, 'batchCreatorUsrId', Number(physicianId));
    body = updateField(body, 'periodId', Number(periodId));
    body = updateField(body, 'batchDescription', batchName);

    return this.runWebServiceRequest(body, 'PeriodBatch/InsertBatch', 'POST');
  }

  /** Port of ReUsableWebserviceUtils.getAllFeeSchedules (FeeSchedule/GetFeeSchedules, GET). */
  protected async getAllFeeSchedules(): Promise<Record<string, unknown>[]> {
    const response = await this.runWebServiceRequest('', 'FeeSchedule/GetFeeSchedules', 'GET');
    return Array.isArray(response.data) ? (response.data as Record<string, unknown>[]) : JSON.parse(response.raw);
  }

  /** Port of ReUsableWebserviceUtils.getCptCodes (Procedures/GetAllProceduresBySearchString, POST). */
  protected async getCptCodes(cptCode: string): Promise<Record<string, unknown>[]> {
    const response = await this.runWebServiceRequest(cptCode, 'Procedures/GetAllProceduresBySearchString', 'POST');
    return Array.isArray(response.data) ? (response.data as Record<string, unknown>[]) : JSON.parse(response.raw);
  }

  /**
   * Fee-schedule writes 500 (empty body) unless the CPT procedure's record lock is held
   * (recordLockTypeId 34, objectId = cptProcedureId) - matching the UI's own
   * RequestLock -> save -> ReleaseLock sequence. Locks are session-scoped, so the release
   * must happen on this same session.
   */
  private async withFeeScheduleLock<T>(cptProcedureId: unknown, fn: () => Promise<T>): Promise<T> {
    const recordLock = { recordLockTypeId: 34, objectId: Number(cptProcedureId), organizationId: null };
    await this.runWebServiceRequest(recordLock, 'Security/RecordLock/RequestLock', 'POST');
    try {
      return await fn();
    } finally {
      await this.runWebServiceRequest(recordLock, 'Security/RecordLock/ReleaseLock', 'POST').catch(() => undefined);
    }
  }

  /** Creates a fee schedule via /facility/business/fee-schedules (POST), which replaced the old /FeeSchedule/Insert. */
  protected async insertFeeScheduleApi(feeScheduleJson: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withFeeScheduleLock(feeScheduleJson.cptProcedureId, async () => {
      const response = await this.runWebServiceRequest(feeScheduleJson, '/facility/business/fee-schedules', 'POST');
      return JSON.parse(response.raw);
    });
  }

  /**
   * Port of ReUsableWebserviceUtils.insertFeeScheduleRecord. The Java original inserted a bare
   * record then set amount/status via FeeSchedule/Update; /facility/business/fee-schedules takes
   * amount and status up front (as the UI's own request does), so this is a single create call.
   */
  protected async insertFeeScheduleRecord(cptCode: string, amount: number, billableStatus: string): Promise<void> {
    const cptProcedures = await this.getCptCodes(cptCode);
    const cptCodeObject = findByField(cptProcedures, 'cptCode', cptCode);
    if (!cptCodeObject) {
      throw new Error(`insertFeeScheduleRecord: no CPT procedure found for code "${cptCode}"`);
    }

    const procedureDisplayName = `${cptCode}; ${cptCodeObject.cptDescription}`;
    cptCodeObject.procedureDisplayName = `${cptCodeObject.cptCode}; ${cptCodeObject.cptDescription}`;

    let insertBody = this.templates.load<Record<string, unknown>>('insertFeeSchedule.json');
    insertBody = updateField(insertBody, 'feeScheduleId', 0);
    insertBody = updateField(insertBody, 'procedure', cptCodeObject.cptDescription);
    insertBody = updateField(insertBody, 'cptProcedureId', cptCodeObject.cptProcedureId);
    insertBody = updateField(insertBody, 'cptProcedure', cptCodeObject);
    insertBody = updateField(insertBody, 'procedureDisplayName', procedureDisplayName);
    insertBody = updateField(insertBody, 'modifiedProcedureDescription', procedureDisplayName);
    insertBody = updateField(insertBody, 'status', billableStatus);
    insertBody = updateField(insertBody, 'followUpDays', '30');
    insertBody = updateField(insertBody, 'amount', amount);
    // effectiveDate is stamped by the server, and the UI's request doesn't send it.
    delete insertBody.effectiveDate;
    insertBody = updateField(insertBody, 'feeScheduleHistoryId', 0);
    insertBody = updateField(insertBody, 'feeScheduleRootId', 0);
    insertBody = updateField(insertBody, 'activeTf', true);
    insertBody = updateField(insertBody, 'isIncludeStateReportTf', true);
    insertBody = updateField(insertBody, 'revenueCodeId', 248);
    insertBody = updateField(insertBody, 'typeOfBill', '0831');

    try {
      await this.insertFeeScheduleApi(insertBody);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A concurrent row already inserted this CPT code's fee schedule between our existence
      // check (in insertFeeSchedule) and this insert - that entry already covers it.
      if (!/\(status 409\) body=You cannot have duplicate procedure names\./.test(message)) {
        throw err;
      }
    }
  }

  /** Port of ReUsableWebserviceUtils.getWorklistArea. Returns 0 for an unrecognized worklistType. */
  protected getWorklistArea(worklistType: string): number {
    const areas: Record<string, number> = {
      preadmissionqx: 1,
      preadmissioninstructions: 2,
      'pre-operative': 3,
      operative: 4,
      recovery: 7,
      postoperativeqx: 9,
      phase1: 5,
      phase2: 6,
      phase3: 8,
      historyphysical: 11,
    };
    return areas[worklistType.toLowerCase()] ?? 0;
  }

  /**
   * Port of ReUsableWebserviceUtils.getWorklistDetails (WorklistConfiguration/GetWorklistTemplates, GET).
   * Caches the found worklistId under Keys.KEY_WORKLIST_ID.
   */
  protected async getWorklistDetails(worklistArea: number, worklistName: string): Promise<boolean> {
    const response = await this.runWebServiceRequest('', `WorklistConfiguration/GetWorklistTemplates?worklistArea=${worklistArea}`, 'GET');
    const encodedName = encodeString2Base64(worklistName);
    const worklists = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const worklist = (worklists as Record<string, unknown>[]).find(
      (w) => String(w.name).toLowerCase() === encodedName.toLowerCase()
    );
    if (!worklist) return false;

    this.responseCache.put(Keys.KEY_WORKLIST_ID, worklist.worklistId);
    return true;
  }

  /** Port of ReUsableWebserviceUtils.isWorklistPresent. */
  protected async isWorklistPresent(worklistType: string, worklistName: string): Promise<boolean> {
    return this.getWorklistDetails(this.getWorklistArea(worklistType), worklistName);
  }

  /** Port of ReUsableWebserviceUtils.getWorklistTemplates - question label -> template filename (under reqTemplates/). */
  private static readonly WORKLIST_QUESTION_TEMPLATES: Record<string, string> = {
    'configurable questions': 'worklist_ConfigurableQuestions',
    'case details': 'worklist_caseDetails',
    cautery: 'worklist_cautery',
    'closure and dressing': 'worklist_ClosureAndDressing',
    equipment: 'worklist_equipment',
    'existing implants': 'worklist_ExistingImplants',
    'hair removed': 'worklist_hairRemoved',
    'implants and prosthesis': 'worklist_ImplantsProsthesis',
    irrigations: 'worklist_Irrigation',
    normothermia: 'worklist_Normothermia',
    'patient position': 'worklist_PatientPosition',
    prep: 'worklist_Prep',
    'psychosocial status': 'worklist_PsychosocialStatus',
    'safety strap': 'worklist_SafetyStrap',
    'site marking': 'worklist_SiteMarking',
    'supplies and instruments': 'worklist_SuppliesAndInstruments',
    tourniquet: 'worklist_Tourniquet',
    'wound class': 'worklist_WoundClass',
    'x-ray': 'worklist_XRay',
    npo: 'worklist_NPO',
    'surgery information': 'worklist_SurgeryInformation',
    'valuables returned': 'worklist_ValuablesReturned',
    'pre-admission questionnaire reviewed': 'worklist_PreAdmissionQuestionnaireReviewed',
    'height weight and bmi': 'worklist_HeightWeightBMI',
    'colon prep': 'worklist_ColonPrep',
    hemoglobin: 'worklist_Hemoglobin',
    'primary language': 'worklist_PrimaryLanguage',
    'valuables collected': 'worklist_ValuablesCollected',
    'visual function assessment': 'worklist_VisualFunctionAssessment',
    'alcohol tobacco and drug use': 'worklist_AlcoholTobaccoDrugUse',
    'family history': 'worklist_FamilyHistory',
    'illnesses and injuries': 'worklist_IllnessInjuryWorklistQuestion',
    'operations and surgeries': 'worklist_SurgicalHistoryWorklistQuestion',
    existingimplantsreadonly: 'worklist_ExistingImplantsReadOnly',
  };

  /**
   * Port of ReUsableWebserviceUtils.getQuestionarieDictionaryId. Normalizes the short
   * worklistType code to the full dictionary name it's filed under, then resolves
   * exactQuestion's dictionary item id via getDictionaryDetails. Returns 0 (matching
   * Java) if no match is found.
   */
  private async getQuestionarieDictionaryId(worklistType: string, exactQuestion: string): Promise<number> {
    const dictionaryNames: Record<string, string> = {
      preadmissionqx: 'Pre-Admission Worklist Questions',
      preadmissioninstructions: 'Pre-Admission Worklist Instructions',
      'pre-operative': 'Pre-Operative Worklist Questions',
      operative: 'Operative Worklist Questions',
      recovery: 'Recovery Worklist Questions',
      postoperativeqx: 'Post-Operative Worklist Questions',
      historyphysical: 'History & Physical Questions',
    };
    const dictionaryName = dictionaryNames[worklistType.toLowerCase()] ?? worklistType;
    const found = await this.getDictionaryDetails(dictionaryName, exactQuestion);
    return found ? Number(this.responseCache.get(Keys.KEY_DICTIONARY_ITEM_ID)) : 0;
  }

  /**
   * Port of ReUsableWebserviceUtils.getEncodedQuestions. Loads the question's template
   * JSON (by worklistQuestionName, resolved via WORKLIST_QUESTION_TEMPLATES), sets
   * Response=1 if the (pipe-separated) responseExactQuestion's first value is "true",
   * marks $IsCompleted (except for NPO, which never carries that field), and - if
   * exactQuestion is set - resolves it (plus any pipe-separated followups) to a
   * dictionary QuestionId/QuestionText. exactQuestion/responseExactQuestion are always
   * blank in the current seed data (no rows populate those columns), so only the
   * base template + Response/$IsCompleted path is exercised in practice.
   */
  private async getEncodedQuestions(
    worklistType: string,
    worklistQuestionName: string,
    exactQuestion: string | undefined,
    responseExactQuestion: string | undefined
  ): Promise<Record<string, unknown>> {
    const templateFileName = WebserviceUtils.WORKLIST_QUESTION_TEMPLATES[worklistQuestionName.toLowerCase()];
    if (!templateFileName) {
      throw new Error(`getEncodedQuestions: no worklist question template known for "${worklistQuestionName}"`);
    }
    const jsonObject = this.templates.load<Record<string, unknown>>(`${templateFileName}.json`);

    const isResponseTrue = (v: string | undefined) => v != null && v !== '' && v.toLowerCase() !== 'blank' && v.split('|')[0]?.toLowerCase() === 'true';
    if (isResponseTrue(responseExactQuestion)) {
      jsonObject.Response = 1;
    }

    jsonObject['$IsCompleted'] = true;
    if (worklistQuestionName.toLowerCase() === 'npo') {
      delete jsonObject['$IsCompleted'];
    }

    if (exactQuestion != null && exactQuestion !== '' && exactQuestion.toLowerCase() !== 'blank') {
      if (exactQuestion.includes('|')) {
        const followupTemplate = (jsonObject.FollowupQuestions as Record<string, unknown>[] | undefined)?.[0];
        const followups: Record<string, unknown>[] = [];
        const exactQuestions = exactQuestion.split('|');
        for (let i = 0; i < exactQuestions.length; i++) {
          const exactQues = exactQuestions[i];
          if (exactQues == null || exactQues === '' || exactQues.toLowerCase() === 'blank') continue;
          if (i !== 0 && followupTemplate) {
            const followup: Record<string, unknown> = { ...followupTemplate };
            followup.QuestionId = await this.getQuestionarieDictionaryId(worklistType, exactQues);
            followup.QuestionText = exactQues;
            if (isResponseTrue(responseExactQuestion?.split('|')[i])) {
              followup.Response = 1;
            }
            followups.push(followup);
          } else if (i === 0) {
            jsonObject.QuestionId = await this.getQuestionarieDictionaryId(worklistType, exactQues);
            jsonObject.QuestionText = exactQues;
          }
        }
        if (followups.length > 0) {
          jsonObject.FollowupQuestions = followups;
        }
      } else {
        jsonObject.QuestionId = await this.getQuestionarieDictionaryId(worklistType, exactQuestion);
        jsonObject.QuestionText = exactQuestion;
      }
    }

    return jsonObject;
  }

  /** Port of ReUsableWebserviceUtils.lockWorklistrecord/unlockWorklistRecord (Security/RecordLock/RequestLock|ReleaseLock, POST). */
  private async lockWorklistrecord(recordLock: Record<string, unknown>): Promise<void> {
    await this.runWebServiceRequest(recordLock, 'Security/RecordLock/RequestLock', 'POST');
  }

  private async unlockWorklistRecord(recordLock: Record<string, unknown>): Promise<void> {
    await this.runWebServiceRequest(recordLock, 'Security/RecordLock/ReleaseLock', 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.addWorklistTemplate (WorklistConfiguration/CreateWorklistTemplate, POST).
   * questions is comma-separated (Java's default delimiter, since no seed-data caller supplies
   * a different one); each entry is mapped via getEncodedQuestions, base64-encoded as a whole,
   * then pushed onto the newly-created worklist via a lock -> GetWorklistTemplate ->
   * UpdateWorklistTemplate -> unlock sequence. exactQuestion/responseExactQuestion aren't
   * exposed as params here since no seed-data row for this operation populates them.
   */
  protected async addWorklistTemplate(
    worklistType: string,
    worklistName: string,
    generalFlag: boolean,
    painFlag: boolean,
    giFlag: boolean,
    eyeFlag: boolean,
    laserFlag: boolean,
    questions: string | undefined
  ): Promise<string> {
    const worklistArea = this.getWorklistArea(worklistType);
    const isPresent = await this.isWorklistPresent(worklistType, worklistName);
    if (isPresent) {
      return String(this.responseCache.get(Keys.KEY_WORKLIST_ID));
    }

    let body = this.templates.load<Record<string, unknown>>('AddWorklistTemplate.json');
    body = updateField(body, 'name', encodeString2Base64(worklistName));
    body = updateField(body, 'worklistArea', worklistArea);
    setPath(body, 'worklistMappings[0].defaultWorklist', generalFlag);
    setPath(body, 'worklistMappings[1].defaultWorklist', painFlag);
    setPath(body, 'worklistMappings[2].defaultWorklist', giFlag);
    setPath(body, 'worklistMappings[3].defaultWorklist', eyeFlag);
    setPath(body, 'worklistMappings[4].defaultWorklist', laserFlag);

    const response = await this.runWebServiceRequest(body, 'WorklistConfiguration/CreateWorklistTemplate', 'POST');
    const worklistId = response.raw;

    if (questions != null && questions.trim() !== '') {
      const questionsList = questions.split(',');
      const questionsArray: Record<string, unknown>[] = [];
      for (const questionName of questionsList) {
        questionsArray.push(await this.getEncodedQuestions(worklistType, questionName, undefined, undefined));
      }
      const encodedQuestions = encodeString2Base64(JSON.stringify({ Questions: questionsArray }));

      const recordLock = this.templates.load<Record<string, unknown>>('recordLock.json');
      recordLock.ObjectId = worklistId;
      await this.lockWorklistrecord(recordLock);

      try {
        const worklistResponse = await this.runWebServiceRequest('', `WorklistConfiguration/GetWorklistTemplate?id=${worklistId}`, 'GET');
        const worklistRequestObject = JSON.parse(worklistResponse.raw) as Record<string, unknown>;
        worklistRequestObject.encodedTemplate = encodedQuestions;
        worklistRequestObject.templateObject = null;
        await this.runWebServiceRequest(worklistRequestObject, 'WorklistConfiguration/UpdateWorklistTemplate', 'POST');
        await this.unlockWorklistRecord(recordLock);
      } catch (err) {
        await this.unlockWorklistRecord(recordLock);
        throw err;
      }
    }

    return worklistId;
  }

  /**
   * Port of ReUsableWebserviceUtils.getDischargeInstrDetails
   * (DischargeInstructionConfiguration/Names, GET). Caches the found
   * configurationId under Keys.KEY_DISCHARGE_INSTR_CONFIGURATION_ID.
   */
  protected async getDischargeInstrDetails(configurationName: string): Promise<boolean> {
    const response = await this.runWebServiceRequest('', 'DischargeInstructionConfiguration/Names', 'GET');
    const encodedName = encodeString2Base64(configurationName);
    const configurations = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const configuration = (configurations as Record<string, unknown>[]).find(
      (c) => String(c.configurationName).toLowerCase() === encodedName.toLowerCase()
    );
    if (!configuration) return false;

    this.responseCache.put(Keys.KEY_DISCHARGE_INSTR_CONFIGURATION_ID, configuration.configurationId);
    return true;
  }

  /**
   * Port of ReUsableWebserviceUtils.addDischargeInstructions
   * (DischargeInstructionConfiguration POST, then DischargeInstructionConfiguration/Update POST).
   */
  protected async addDischargeInstructions(
    configurationName: string,
    generalFlag: boolean,
    painFlag: boolean,
    giFlag: boolean,
    eyeFlag: boolean,
    laserFlag: boolean
  ): Promise<string> {
    const encodedName = encodeString2Base64(configurationName);
    const createResponse = await this.runWebServiceRequest(
      { configurationName: encodedName, configurationId: 0 },
      'DischargeInstructionConfiguration',
      'POST'
    );
    const configurationId = Number(createResponse.raw);

    let body = this.templates.load<Record<string, unknown>>('DischargeInstructions.json');
    body = updateField(body, 'configurationId', configurationId);
    body = updateField(body, 'configurationName', encodedName);
    body = updateField(body, 'organizationId', Number(this.responseCache.getString(Keys.KEY_ORG_ID)));
    setPath(body, 'casePackMappings[0].defaultTf', generalFlag);
    setPath(body, 'casePackMappings[0].configurationId', configurationId);
    setPath(body, 'casePackMappings[1].defaultTf', painFlag);
    setPath(body, 'casePackMappings[1].configurationId', configurationId);
    setPath(body, 'casePackMappings[2].defaultTf', giFlag);
    setPath(body, 'casePackMappings[2].configurationId', configurationId);
    setPath(body, 'casePackMappings[3].defaultTf', eyeFlag);
    setPath(body, 'casePackMappings[3].configurationId', configurationId);
    setPath(body, 'casePackMappings[4].defaultTf', laserFlag);
    setPath(body, 'casePackMappings[4].configurationId', configurationId);

    const response = await this.runWebServiceRequest(body, 'DischargeInstructionConfiguration/Update', 'POST');
    return response.raw;
  }

  /**
   * Port of ReUsableWebserviceUtils.getConsentDetails (ConsentConfiguration/names, GET).
   * Caches the found consentId under Keys.KEY_CONSENTS_ID.
   */
  protected async getConsentDetails(name: string): Promise<boolean> {
    const response = await this.runWebServiceRequest('', 'ConsentConfiguration/names', 'GET');
    const encodedName = encodeString2Base64(name);
    const consents = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const consent = (consents as Record<string, unknown>[]).find(
      (c) => String(c.name).toLowerCase() === encodedName.toLowerCase()
    );
    if (!consent) return false;

    this.responseCache.put(Keys.KEY_CONSENTS_ID, consent.consentId);
    return true;
  }

  /**
   * Port of ReUsableWebserviceUtils.addConsent (ConsentConfiguration POST to create,
   * then ConsentConfiguration PUT with the full template to configure case mappings and
   * statement text). consentStatementText is a '|'-separated list of statements, each
   * optionally suffixed with ",yes"/",no" to override the default patientSigneeTf; signeeDetails
   * is a '|'-separated list (positionally matched to consentStatementText) of ','-separated
   * "Mandatory Signee" dictionary values, resolved via getDictionaryDetails.
   */
  protected async addConsent(
    consentName: string,
    generalFlag: boolean,
    painFlag: boolean,
    giFlag: boolean,
    eyeFlag: boolean,
    laserFlag: boolean,
    physicianScheduleFlag: boolean,
    procdeureScheduleFlag: boolean,
    diagnosisScheduleFlag: boolean,
    consentStatementText: string | undefined,
    signeeDetails: string | undefined
  ): Promise<string> {
    const relURL = 'ConsentConfiguration';
    const encodedConsentName = encodeString2Base64(consentName);
    const createResponse = await this.runWebServiceRequestWithRetryOnTransientFailure(
      {
        consentConfigurationName: encodedConsentName,
        schedulePhysicianTf: physicianScheduleFlag,
        scheduleProcedureTf: procdeureScheduleFlag,
        scheduleDiagnosisTf: diagnosisScheduleFlag,
        expireTf: false,
      },
      relURL,
      'POST'
    );
    const created = JSON.parse(createResponse.raw) as Record<string, unknown>;
    const consentId = Number(created.consentConfigurationId);

    let body = this.templates.load<Record<string, unknown>>('AddConsents.json');
    body = updateField(body, 'consentConfigurationId', consentId);
    body = updateField(body, 'consentConfigurationName', encodedConsentName);
    body = updateField(body, 'schedulePhysicianTf', physicianScheduleFlag);
    body = updateField(body, 'scheduleProcedureTf', procdeureScheduleFlag);
    body = updateField(body, 'scheduleDiagnosisTf', diagnosisScheduleFlag);
    body = updateField(body, 'organizationId', Number(this.responseCache.getString(Keys.KEY_ORG_ID)));
    setPath(body, 'consentCaseMappings[0].defaultTf', generalFlag);
    setPath(body, 'consentCaseMappings[0].consentConfigurationId', consentId);
    setPath(body, 'consentCaseMappings[1].defaultTf', painFlag);
    setPath(body, 'consentCaseMappings[1].consentConfigurationId', consentId);
    setPath(body, 'consentCaseMappings[2].defaultTf', giFlag);
    setPath(body, 'consentCaseMappings[2].consentConfigurationId', consentId);
    setPath(body, 'consentCaseMappings[3].defaultTf', eyeFlag);
    setPath(body, 'consentCaseMappings[3].consentConfigurationId', consentId);
    setPath(body, 'consentCaseMappings[4].defaultTf', laserFlag);
    setPath(body, 'consentCaseMappings[4].consentConfigurationId', consentId);

    if (!isBlank(consentStatementText)) {
      const statements = consentStatementText!.split('|');
      const signeeDetailsList = signeeDetails?.split('|') ?? [];
      const consentStatements: Record<string, unknown>[] = [];

      for (let statementOrder = 0; statementOrder < statements.length; statementOrder++) {
        let consentStmtText = statements[statementOrder];
        const signeeDetail = signeeDetailsList[statementOrder];
        let patientSigneeTf = true;

        if (consentStmtText.includes(',')) {
          const [stmtText, signeeFlag] = consentStmtText.split(',');
          consentStmtText = stmtText;
          if (signeeFlag.toLowerCase() === 'yes') {
            patientSigneeTf = true;
          } else if (signeeFlag.toLowerCase() === 'no') {
            patientSigneeTf = false;
          }
        }

        const consentStatementSignee: Record<string, unknown>[] = [];
        if (!isBlank(signeeDetail)) {
          const signees = signeeDetail!.split(',');
          for (let i = 0; i < signees.length; i++) {
            await this.getDictionaryDetails('Mandatory Signee', signees[i]);
            consentStatementSignee.push({
              signeeDictionaryId: this.responseCache.get(Keys.KEY_DICTIONARY_ITEM_ID),
              signeeDictionaryOrder: i + 1,
            });
          }
        }

        consentStatements.push({
          patientSigneeTf,
          consentConfigurationId: consentId,
          statementOrder,
          isEditorFocused: false,
          isEditorDisabled: false,
          consentStatementSignee,
          consentStatementText: { statementText: encodeString2Base64(consentStmtText) },
        });
      }

      body = updateField(body, 'consentStatements', consentStatements);
    }

    const response = await this.runWebServiceRequestWithRetryOnTransientFailure(body, relURL, 'PUT');
    return response.raw;
  }

  /** Port of ReUsableWebserviceUtils.reqlockCasePatient/releaseLockPatient's generic RecordLock request shape (Security/RecordLock/RequestLock, POST). */
  protected async requestLock(recordLockTypeId: number): Promise<void> {
    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID);
    await this.runWebServiceRequest(
      { CaseSummaryId: Number(caseSummaryId), RecordLockTypeId: recordLockTypeId },
      'Security/RecordLock/RequestLock',
      'POST'
    );
  }

  /** Port of ReUsableWebserviceUtils.relreaseLockPatient (Security/RecordLock/ReleaseLock, POST). */
  protected async releaseLock(recordLockTypeId: number): Promise<void> {
    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID);
    await this.runWebServiceRequest(
      { CaseSummaryId: Number(caseSummaryId), RecordLockTypeId: recordLockTypeId },
      'Security/RecordLock/ReleaseLock',
      'POST'
    );
  }

  /** Port of ReUsableWebserviceUtils.payerEligibilityReq (/Eligibility/PayerEligibility/send/{caseSummaryId}/{patientId}/1/-1, POST). */
  protected async sendPayerEligibility(): Promise<void> {
    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID);
    const patientId = this.responseCache.getString(Keys.KEY_PATIENT_ID);
    await this.runWebServiceRequest('', `/Eligibility/PayerEligibility/send/${caseSummaryId}/${patientId}/1/-1`, 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.getCaseDetailInformation
   * (PatientFacesheet/GetCaseDetailInformation/{patientId}/{caseSummaryId}, GET).
   * Finds the module matching departmentname and caches its moduleId/itemId
   * under Keys.KEY_MODULE_ID/KEY_CASE_ITEM_ID for the caller to read back.
   */
  protected async getCaseDetailInformation(departmentname: string): Promise<void> {
    const patientId = this.responseCache.getString(Keys.KEY_PATIENT_ID);
    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID);
    const response = await this.runWebServiceRequest('', `PatientFacesheet/GetCaseDetailInformation/${patientId}/${caseSummaryId}`, 'GET');
    const parsed = typeof response.data === 'object' && response.data !== null ? response.data : JSON.parse(response.raw);
    const modules = (parsed as Record<string, unknown>).modules as Record<string, unknown>[];
    const module = findByField(modules, 'moduleName', departmentname);
    if (!module) {
      throw new Error(`getCaseDetailInformation: no module found with name "${departmentname}"`);
    }
    this.responseCache.put(Keys.KEY_CASE_ITEM_ID, module.itemId);
    this.responseCache.put(Keys.KEY_MODULE_ID, module.moduleId);
  }

  /**
   * Port of ReUsableWebserviceUtils.updatePatientArrivalTime
   * (/AppointmentInformation/UpdateArrivalTime/{appointmentId}, POST).
   * Body is a raw ISO-ish datetime string, not a JSON object, matching the Java original.
   */
  protected async updatePatientArrivalTime(date: string, time: string, appointmentId: string): Promise<void> {
    const formattedDate = addDate(date, 'yyyy-MM-dd');
    await this.runWebServiceRequest(`${formattedDate}T${time}:15.480Z`, `/AppointmentInformation/UpdateArrivalTime/${appointmentId}`, 'POST');
  }

  /** Port of ReUsableWebserviceUtils.updateCaseStatus (CaseSummary/UpdateCaseSatus/{caseSummaryId}, POST). Body is a raw string status code. */
  protected async updateCaseStatus(caseSummaryId: string, caseStatus: string): Promise<void> {
    await this.runWebServiceRequest(caseStatus, `CaseSummary/UpdateCaseSatus/${caseSummaryId}`, 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.UpsertCaseSummaryInfo/UpsertCaseSummaryInfoForArrival
   * (CaseSummary/UpsertCaseSummaryInfo, PUT). Consolidates the several call sites that
   * differ only in (status, statusAtDischarge, previousStatus) into one shared helper.
   */
  protected async upsertCaseSummaryInfo(
    status: string,
    statusAtDischarge: string | null,
    previousStatus: string | null
  ): Promise<void> {
    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID);
    const caseStartTime = this.responseCache.getString(Keys.KEY_CASE_START_TIME);
    const appointmentId = this.responseCache.getString(Keys.KEY_CASE_APPOINTMENT_ID);
    const caseType = this.getAppointmentTypeCaseType();

    let body = this.templates.load<Record<string, unknown>>('UpsertCaseSummaryInfo.json');
    body = updateField(body, 'caseSummaryId', Number(caseSummaryId));
    body = updateField(body, 'acuteChronicTf', true);
    body = updateField(body, 'created', caseStartTime);
    body = updateField(body, 'status', status);
    body = updateField(body, 'statusAtDischarge', statusAtDischarge);
    body = updateField(body, 'previousStatus', previousStatus);
    body = updateField(body, 'appointmentId', Number(appointmentId));
    body = updateField(body, 'caseType', caseType);

    await this.runWebServiceRequest(body, 'CaseSummary/UpsertCaseSummaryInfo', 'PUT');
  }

  /**
   * Port of ReUsableWebserviceUtils.getpatientObjfromName (/PatientData/Gemini/SearchToken, POST).
   * Finds the existing patient matching fullName and caches it under
   * Keys.KEY_CREATE_PATIENT_RESPONSE - the same key createJustAPatient uses -
   * so createCaseSummary can build off it identically either way.
   */
  protected async getPatientObjFromName(patientsearchstring: string, fullName: string): Promise<void> {
    const response = await this.runWebServiceRequest(
      { pageCount: 0, fetchImages: true, searchString: patientsearchstring },
      '/PatientData/Gemini/SearchToken',
      'POST'
    );
    const results = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const patient = findByField(results as Record<string, unknown>[], 'fullName', fullName);
    if (!patient) {
      throw new Error(`getPatientObjFromName: no existing patient found with fullName "${fullName}"`);
    }
    patient.adtLockedFieldList = [];
    this.responseCache.put(Keys.KEY_CREATE_PATIENT_RESPONSE, JSON.stringify(patient));
  }

  /** Port of ReUsableWebserviceUtils.isFeatureEnabled (/Security/GetAllFeatureStatesForConfiguration, GET). */
  protected async isFeatureEnabled(featureName: string): Promise<boolean> {
    const response = await this.runWebServiceRequest('', '/Security/GetAllFeatureStatesForConfiguration', 'GET');
    const features = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const feature = findByField(features as Record<string, unknown>[], 'featureName', featureName);
    return Boolean(feature?.isEnabled);
  }

  /**
   * Port of ReUsableWebserviceUtils.getMedication (/MedicationTemplate/GetMedicationTemplates, GET).
   * medicationname is a ';'-separated list of template names, each resolved to a medicationTemplateId.
   */
  protected async getMedicationTemplateIds(medicationname: string): Promise<number[]> {
    const response = await this.runWebServiceRequest('', '/MedicationTemplate/GetMedicationTemplates', 'GET');
    const templates = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    return medicationname.split(';').map((name) => {
      const template = findByField(templates as Record<string, unknown>[], 'templateName', name);
      if (!template) {
        throw new Error(`getMedicationTemplateIds: no medication template found with name "${name}"`);
      }
      return Number(template.medicationTemplateId);
    });
  }

  /**
   * Port of ReUsableWebserviceUtils.insertMedicationAdministrations (legacy/non-Orders path).
   * Fetches the case's scheduled medications and submits an administration
   * record for each one, using the current date/time.
   */
  protected async insertMedicationAdministrations(userName: string): Promise<void> {
    const [userFullName, staffId, personId] = await this.getPhysicianNameIDFromPhysicianName(userName);
    const moduleId = this.responseCache.getString(Keys.KEY_MODULE_ID);
    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID);

    const response = await this.runWebServiceRequest('', `Medication/GetMedications?caseSummaryId=${caseSummaryId}&moduleId=${moduleId}`, 'GET');
    const medications = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);

    const template = this.templates.load<Record<string, unknown>[]>('InsertMedicationAdministrations.json');
    const itemTemplate = template[0];

    const now = new Date();
    const mmddyyyy = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`;
    const hhmmss = now.toTimeString().slice(0, 8);
    const hhmm = now.toTimeString().slice(0, 5);

    const requests = (medications as Record<string, unknown>[]).map((medication) => {
      const item: Record<string, unknown> = JSON.parse(JSON.stringify(itemTemplate));
      for (const field of ['medicationId', 'dose', 'route', 'unit', 'site', 'routeId', 'unitId', 'siteId']) {
        if (medication[field] != null) item[field] = medication[field];
      }
      item.administeredById = staffId;
      item.administeredBy = userFullName;
      item.chartedBy = userFullName;
      item.chartedById = personId;
      item.date = mmddyyyy;
      item.previousServerDate = mmddyyyy;
      item.time = hhmmss;
      item.previousServerTime = hhmm;
      item.dateTime = `${addDate('today', 'yyyy-MM-dd')}T${hhmmss}+05:30`;
      return item;
    });

    await this.runWebServiceRequest(requests, 'Medication/InsertMedicationAdministrations', 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.getStaffDetails (/StaffList/GetStaffForFacility, POST).
   * Caches staffId/staffFullName/staffRoleId for the matched userName under
   * Keys.KEY_STAFF_ID/KEY_STAFF_FULL_NAME/KEY_STAFF_ROLE_ID.
   */
  protected async getStaffDetails(userName: string): Promise<void> {
    const response = await this.getPhysicianeNameAndID();
    const staff = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const staffDetails = findByField(staff as Record<string, unknown>[], 'lastName', userName);
    if (!staffDetails) {
      throw new Error(`getStaffDetails: no staff found with lastName "${userName}"`);
    }
    this.responseCache.put(Keys.KEY_STAFF_ID, staffDetails.staffId);
    this.responseCache.put(Keys.KEY_STAFF_FULL_NAME, staffDetails.fullName);
    this.responseCache.put(Keys.KEY_STAFF_ROLE_ID, staffDetails.roleId);
  }

  /** Port of ReUsableWebserviceUtils.getFormByName (RecordHeader/Patient Panel/GetFormbyName, GET). Caches formId under Keys.KEY_CASE_FORM_ID. */
  protected async getFormByName(): Promise<void> {
    const response = await this.runWebServiceRequest('', 'RecordHeader/Patient Panel/GetFormbyName', 'GET');
    const parsed = typeof response.data === 'object' && response.data !== null ? response.data : JSON.parse(response.raw);
    if (!parsed) {
      throw new Error('getFormByName: RecordHeader/Patient Panel/GetFormbyName returned no form for the current session/org');
    }
    this.responseCache.put(Keys.KEY_CASE_FORM_ID, (parsed as Record<string, unknown>).formId);
  }

  /**
   * Port of ReUsableWebserviceUtils.getFormUsagebyByFormOwner (no-arg overload,
   * FormUsage/GetFormUsagebyByFormOwner, POST). Caches the response's formId
   * field under Keys.KEY_CASE_FORM_USAGE_ID (matching the Java original, which
   * reads the usage id back out of the response's "formId" field). The form-usage
   * record may not be visible yet immediately after case creation under concurrent
   * load - retry briefly before treating it as genuinely missing.
   */
  protected async getFormUsagebyByFormOwner(): Promise<void> {
    const moduleId = this.responseCache.getString(Keys.KEY_MODULE_ID);
    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID);
    const formId = this.responseCache.getString(Keys.KEY_CASE_FORM_ID);

    let body = this.templates.load<Record<string, unknown>>('GetFormUsagebyByFormOwner.json');
    body = updateField(body, 'caseSummaryId', caseSummaryId);
    body = updateField(body, 'moduleId', Number(moduleId));
    body = updateField(body, 'formId', Number(formId));

    const parsed = await this.pollUntilFound(async () => {
      const response = await this.runWebServiceRequest(body, 'FormUsage/GetFormUsagebyByFormOwner', 'POST');
      const result = typeof response.data === 'object' && response.data !== null ? response.data : JSON.parse(response.raw);
      return (result ?? undefined) as Record<string, unknown> | undefined;
    });
    if (!parsed) {
      throw new Error('getFormUsagebyByFormOwner: FormUsage/GetFormUsagebyByFormOwner returned no form usage record');
    }
    this.responseCache.put(Keys.KEY_CASE_FORM_USAGE_ID, parsed.formId);
  }

  /** Port of ReUsableWebserviceUtils.updateFormUsagebyByFormOwner (no-arg overload, FormUsage/UpdateFormUsageByFormOwner, POST). */
  protected async updateFormUsagebyByFormOwner(): Promise<void> {
    let body = this.templates.load<Record<string, unknown>>('updateFormUsagebyByFormOwner.json');
    body = updateField(body, 'formUsageId', this.responseCache.getString(Keys.KEY_CASE_FORM_USAGE_ID));
    body = updateField(body, 'caseSummaryId', this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID));
    body = updateField(body, 'moduleId', this.responseCache.getString(Keys.KEY_MODULE_ID));
    body = updateField(body, 'formId', this.responseCache.getString(Keys.KEY_CASE_FORM_ID));
    body = updateField(body, 'staffId', this.responseCache.getString(Keys.KEY_STAFF_ID));
    body = updateField(body, 'staffName', this.responseCache.getString(Keys.KEY_STAFF_FULL_NAME));
    body = updateField(body, 'lastUpdated', `${addDate('today', 'yyyy-MM-dd')}T01:00:00.000`);

    await this.runWebServiceRequest(body, 'FormUsage/UpdateFormUsageByFormOwner', 'POST');
  }

  /** Port of ReUsableWebserviceUtils.insertAreaOfCareInformation (AreaCareInformation/InsertAreaCareInformation, POST). */
  protected async insertAreaOfCareInformation(procedureDt: string): Promise<void> {
    const formattedDate = addDate(procedureDt, 'yyyy-MM-dd');
    let body = this.templates.load<Record<string, unknown>>('InsertAreaOfCareInformation.json');
    body = updateField(body, 'caseSummaryId', this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID));
    body = updateField(body, 'moduleId', Number(this.responseCache.getString(Keys.KEY_MODULE_ID)));
    body = updateField(body, 'patientId', this.responseCache.getString(Keys.KEY_PATIENT_ID));
    body = updateField(body, 'admissionTime', `${formattedDate}T${new Date().toTimeString().slice(0, 5)}:00+05:30`);

    await this.runWebServiceRequest(body, 'AreaCareInformation/InsertAreaCareInformation', 'POST');
  }

  /** Port of ReUsableWebserviceUtils.saveAreaOfCareStaffDetails (no-arg overload, AreaOfCareStaffEntry/SaveAreaOfCareStaffDetails, POST). */
  protected async saveAreaOfCareStaffDetails(): Promise<void> {
    let body = this.templates.load<Record<string, unknown>>('SaveAreaOfCareStaffDetails.json');
    setPath(body, 'areaofCareStaffEntryDetails[0].staffId', Number(this.responseCache.getString(Keys.KEY_STAFF_ID)));
    setPath(body, 'areaofCareStaffEntryDetails[0].staffRoleId', Number(this.responseCache.getString(Keys.KEY_STAFF_ROLE_ID)));
    body = updateField(body, 'caseSummaryId', this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID));
    body = updateField(body, 'moduleId', this.responseCache.getString(Keys.KEY_MODULE_ID));
    setPath(body, 'areaofCareStaffEntryDetails[0].inTimeDt', `${addDate('today', 'yyyy-MM-dd')}T${new Date().toTimeString().slice(0, 5)}:00-0500`);

    await this.runWebServiceRequestWithRetryOnTransientFailure(body, 'AreaOfCareStaffEntry/SaveAreaOfCareStaffDetails', 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.getModulesBycaseId (Module/GetModulesBycaseId/{caseSummaryId}/undefined?organisationId={orgId}, GET).
   * Caches/returns the matched module's moduleId under Keys.KEY_MODULE_ID.
   */
  protected async getModulesBycaseId(departmentName: string): Promise<string> {
    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID);
    const orgId = this.responseCache.getString(Keys.KEY_ORG_ID);
    const response = await this.runWebServiceRequest('', `Module/GetModulesBycaseId/${caseSummaryId}/undefined?organisationId=${orgId}`, 'GET');
    const modules = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const module = findByField(modules as Record<string, unknown>[], 'moduleName', departmentName);
    if (!module) {
      throw new Error(`getModulesBycaseId: no module found with name "${departmentName}"`);
    }
    const moduleId = String(module.moduleId);
    this.responseCache.put(Keys.KEY_MODULE_ID, moduleId);
    return moduleId;
  }

  /**
   * Port of ReUsableWebserviceUtils.getCasePhysicianOrderId
   * (/PhysicianOrdersDocumentation/Names/Case/{caseSummaryId}/Module/{moduleId}, GET).
   * If a physician-order record already exists for this case/module, caches its
   * casePhysicianOrderId; otherwise leaves whatever createCasePhysicianOrderId
   * already cached untouched (matching the Java original's literal-"null" check).
   */
  protected async getCasePhysicianOrderId(departmentName: string): Promise<void> {
    await this.getCaseDetailInformation(departmentName);
    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID);
    const moduleId = this.responseCache.getString(Keys.KEY_MODULE_ID);
    const response = await this.runWebServiceRequest('', `/PhysicianOrdersDocumentation/Names/Case/${caseSummaryId}/Module/${moduleId}`, 'GET');
    if (response.raw !== 'null') {
      const physicianOrderDetails = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
      this.responseCache.put(Keys.KEY_CASE_PHYSICIAN_ORDER_ID, (physicianOrderDetails as Record<string, unknown>[])[0]?.casePhysicianOrderId);
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.createCasePhysicianOrderId
   * (/PhysicianOrdersDocumentation/{moduleId}, POST). Creates the "Verbal Orders"
   * physician-order container that addMedicationToOrders' order entries attach to.
   */
  protected async createCasePhysicianOrderId(departmentName: string): Promise<void> {
    const moduleId = await this.getModulesBycaseId(departmentName);
    const relURL = `/PhysicianOrdersDocumentation/${moduleId}`;

    let body = this.templates.load<Record<string, unknown>>('createOrderId.json');
    body = updateField(body, 'caseSummaryId', this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID));
    body = updateField(body, 'casePhysicianOrderId', 0);
    body = updateField(body, 'caseModuleOrderMaps', [{ moduleId: Number(moduleId), orders: [] }]);

    const response = await this.runWebServiceRequest(body, relURL, 'POST');
    this.responseCache.put(Keys.KEY_CASE_PHYSICIAN_ORDER_ID, response.raw);
  }

  /** Port of ReUsableWebserviceUtils.getMedicationTemplate - resolves one medication template's full details by name. */
  private async getMedicationTemplate(medicationTemplateName: string): Promise<Record<string, unknown>> {
    const response = await this.runWebServiceRequest('', '/MedicationTemplate/GetMedicationTemplates', 'GET');
    const templates = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const template = findByField(templates as Record<string, unknown>[], 'templateName', medicationTemplateName);
    if (!template) {
      throw new Error(`getMedicationTemplate: no medication template found with name "${medicationTemplateName}"`);
    }
    return template;
  }

  /** Port of ReUsableWebserviceUtils.getMedicationOrder - builds one order entry for addMedicationToOrders. */
  private async getMedicationOrder(moduleId: string, medicationTemplateName: string, sortOrder: number): Promise<Record<string, unknown>> {
    const medicationTemplate = await this.getMedicationTemplate(medicationTemplateName);

    let body = this.templates.load<Record<string, unknown>>('AddMedicationTemplateToOrders.json');
    body = updateField(body, 'casePhysicianOrderId', Number(this.responseCache.getString(Keys.KEY_CASE_PHYSICIAN_ORDER_ID)));
    body = updateField(body, 'moduleId', Number(moduleId));
    setPath(body, 'medicationOrder.medicationName', medicationTemplate.medication);
    setPath(body, 'medicationOrder.templateName', medicationTemplate.templateName);
    setPath(body, 'medicationOrder.templateId', Number(medicationTemplate.medicationTemplateId));
    setPath(body, 'medicationOrder.compoundMedicationTf', Boolean(medicationTemplate.compoundTf));
    setPath(body, 'medicationOrder.dispensableDrugId', medicationTemplate.dispensableDrugId);
    setPath(body, 'medicationOrder.defaultETCID', medicationTemplate.defaultETCID);
    setPath(body, 'medicationOrder.defaultETCDesc', medicationTemplate.defaultETCDesc);
    body = updateField(body, 'nursingOrderTf', true);
    body = updateField(body, 'sortOrder', sortOrder);
    return body;
  }

  /**
   * Port of ReUsableWebserviceUtils.addMedicationToOrders
   * (/PhysicianOrdersDocumentation/CaseBaseOrders/{moduleId}, POST). medicationNames
   * is ';'-separated; each becomes one order entry, sortOrder = its index.
   */
  protected async addMedicationToOrders(medicationNames: string, departmentName: string): Promise<void> {
    const moduleId = await this.getModulesBycaseId(departmentName);
    const relURL = `/PhysicianOrdersDocumentation/CaseBaseOrders/${moduleId}`;

    const names = medicationNames.split(';');
    const orderMedicationTemplates: Record<string, unknown>[] = [];
    for (let i = 0; i < names.length; i++) {
      orderMedicationTemplates.push(await this.getMedicationOrder(moduleId, names[i], i));
    }

    await this.runWebServiceRequest(orderMedicationTemplates, relURL, 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.getMedicationsAddedToDepartment
   * (/PhysicianOrdersDocumentation/{casePhysicianOrderId}/{moduleId}, GET).
   */
  private async getMedicationsAddedToDepartment(departmentName: string): Promise<Record<string, unknown>[]> {
    const moduleId = await this.getModulesBycaseId(departmentName);
    const casePhysicianOrderId = this.responseCache.getString(Keys.KEY_CASE_PHYSICIAN_ORDER_ID);
    const response = await this.runWebServiceRequest('', `/PhysicianOrdersDocumentation/${casePhysicianOrderId}/${moduleId}`, 'GET');
    const medicationOrders = JSON.parse(response.raw) as Record<string, unknown>;
    const caseModuleOrderMaps = medicationOrders.caseModuleOrderMaps as Record<string, unknown>[];
    const caseModuleOrders = findByField(caseModuleOrderMaps, 'moduleId', moduleId);
    return (caseModuleOrders?.orders as Record<string, unknown>[] | undefined) ?? [];
  }

  /**
   * Port of ReUsableWebserviceUtils.administerMedicationsInOrders
   * (/PhysicianOrdersDocumentation/MedicationAdministration, POST once per order).
   * Literal time-of-day constants ("14:16:31.301Z"/"19:46:31") match the Java original.
   */
  protected async administerMedicationsInOrders(departmentName: string): Promise<void> {
    const medications = await this.getMedicationsAddedToDepartment(departmentName);
    for (const medication of medications) {
      let body = this.templates.load<Record<string, unknown>>('AdministerMedications.json');
      body = updateField(body, 'dateTime', `${addDate('Today', 'yyyy-MM-dd')}T14:16:31.301Z`);
      body = updateField(body, 'caseBaseOrderId', Number(medication.caseBaseOrderId));
      body = updateField(body, 'date', addDate('Today', 'MM-dd-yyyy'));
      body = updateField(body, 'time', '19:46:31');
      await this.runWebServiceRequest(body, '/PhysicianOrdersDocumentation/MedicationAdministration', 'POST');
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.getAreaCareInformationsbyCase (no-arg and
   * String-department overloads; AreaCareInformation/GetAreaCareInformationsbyCase, POST).
   * When departmentName is omitted, the request body omits moduleId (matching
   * the Java no-arg overload); when provided, moduleId is read from the
   * already-cached Keys.KEY_MODULE_ID (NOT re-fetched), matching the Java original.
   */
  protected async getAreaCareInformationsbyCase(departmentName?: string): Promise<void> {
    const patientId = Number(this.responseCache.getString(Keys.KEY_PATIENT_ID));
    const caseSummaryId = Number(this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID));
    const body: Record<string, unknown> = { casesummaryId: caseSummaryId, patientId };
    if (departmentName !== undefined) {
      body.moduleId = Number(this.responseCache.getString(Keys.KEY_MODULE_ID));
    }
    const response = await this.runWebServiceRequest(body, 'AreaCareInformation/GetAreaCareInformationsbyCase', 'POST');
    if (response.raw && response.raw !== '[]') {
      const parsed = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
      const first = (parsed as Record<string, unknown>[])[0];
      if (first) this.responseCache.put(Keys.KEY_AREA_OF_CARE_ID, String(first.areaOfCareInformationId));
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.requestLock (no-arg overload, Security/RecordLock/RequestLock, POST).
   * Distinct from the (recordLockTypeId) overload used for insurance eligibility -
   * this one is module-scoped (RecordLockTypeId 16) and used by the discharge flow.
   */
  protected async requestModuleLock(): Promise<void> {
    const caseSummaryId = Number(this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID));
    const moduleId = Number(this.responseCache.getString(Keys.KEY_MODULE_ID));
    await this.runWebServiceRequest({ casesummaryId: caseSummaryId, RecordLockTypeId: 16, moduleId }, 'Security/RecordLock/RequestLock', 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.requestLock(String departmentname) overload
   * (Security/RecordLock/RequestLock, POST). Re-fetches moduleId for departmentName.
   */
  protected async requestModuleLockForDepartment(departmentName: string): Promise<void> {
    const caseSummaryId = Number(this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID));
    const moduleId = Number(await this.getModulesBycaseId(departmentName));
    await this.runWebServiceRequest({ casesummaryId: caseSummaryId, RecordLockTypeId: 16, moduleId }, 'Security/RecordLock/RequestLock', 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.releaseLockPatient(String departmentName)
   * (Security/RecordLock/ReleaseLock, POST). Re-fetches moduleId for departmentName.
   */
  protected async releaseModuleLock(departmentName: string): Promise<void> {
    const caseSummaryId = Number(this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID));
    const moduleId = Number(await this.getModulesBycaseId(departmentName));
    await this.runWebServiceRequest({ CaseSummaryId: caseSummaryId, RecordLockTypeId: 16, moduleId }, 'Security/RecordLock/ReleaseLock', 'POST');
  }

  /** Port of ReUsableWebserviceUtils.getPatientHandsOffData (/patientHandOff/GetPatientHandsOffData, GET). */
  protected async getPatientHandsOffData(): Promise<Record<string, unknown>> {
    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID);
    const moduleId = this.responseCache.getString(Keys.KEY_MODULE_ID);
    const response = await this.runWebServiceRequest('', `/patientHandOff/GetPatientHandsOffData?casesummaryId=${caseSummaryId}&moduleId=${moduleId}`, 'GET');
    return typeof response.data === 'object' && response.data !== null ? (response.data as Record<string, unknown>) : JSON.parse(response.raw);
  }

  /** Port of ReUsableWebserviceUtils.getdischargedToLocationIdByvalue (/Dictionary/v2/6/All, GET). */
  protected async getDischargedToLocationId(dischargeToValue: string): Promise<string> {
    const response = await this.runWebServiceRequest('', '/Dictionary/v2/6/All', 'GET');
    const items = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const item = findByField(items as Record<string, unknown>[], 'value', dischargeToValue);
    if (!item) {
      throw new Error(`getDischargedToLocationId: no dictionary item found with value "${dischargeToValue}"`);
    }
    return String(item.id);
  }

  /**
   * Port of ReUsableWebserviceUtils.insertPatientHandOffData. Reuses the
   * existing hand-off object (from getPatientHandsOffData) as the base
   * payload, matching the Java original's re-spread-as-template pattern.
   */
  protected async insertPatientHandOffData(caseStatus: number, defaultCaseStatusId: number, dischargedToValue: string | null): Promise<void> {
    const base = await this.getPatientHandsOffData();
    const transferTime = `${addDate('today', 'yyyy-MM-dd')}T${new Date().toTimeString().slice(0, 5)}:00+05:30`;
    const transferTimeOfTime = `${new Date().toTimeString().slice(0, 5)}`;

    const body: Record<string, unknown> = { ...base };
    body.transferTime = transferTime;
    body.transferredById = null;
    body.dischargedOnDt = transferTime;
    body.transferTimeOF_Time = transferTimeOfTime;
    body.caseStatus = caseStatus;
    body.defaultCaseStatusId = defaultCaseStatusId;
    body.dischargeNormalTf = true;

    if (caseStatus !== 4 && dischargedToValue != null) {
      body.discharged_To_Value = dischargedToValue;
      body.dischargedToLocationId = Number(await this.getDischargedToLocationId(dischargedToValue));
    }

    await this.runWebServiceRequest(body, 'patientHandOff/InsertPatientHandOffData', 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.insertAreaOfCareinforamtion_Operative
   * (AreaCareInformation/InsertAreaCareInformation, POST). moduleId is
   * hardcoded to 1020, matching the Java original (a known quirk - it doesn't
   * use the dynamically-fetched Pre-Operative moduleId here).
   */
  protected async insertAreaOfCareinforamtionOperative(admitSourceValue: string, procedureDt: string): Promise<void> {
    const formattedDate = addDate(procedureDt, 'yyyy-MM-dd');
    let body = this.templates.load<Record<string, unknown>>('insertAreaOfCareinforamtion_Operative.json');
    body = updateField(body, 'caseSummaryId', this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID));
    body = updateField(body, 'moduleId', 1020);
    body = updateField(body, 'admissionTime', `${formattedDate}T${new Date().toTimeString().slice(0, 5)}:00+05:30`);
    body = updateField(body, 'admitSourceValue', admitSourceValue);
    body = updateField(body, 'patientId', this.responseCache.getString(Keys.KEY_PATIENT_ID));

    await this.runWebServiceRequest(body, 'AreaCareInformation/InsertAreaCareInformation', 'POST');
  }

  /** Port of ReUsableWebserviceUtils.getScheduledProcedures (ScheduledCaseProcedure/GetScheduledProcedures/{caseSummaryId}/false, GET). */
  protected async getScheduledProcedures(caseSummaryId: string): Promise<Record<string, unknown>[]> {
    // The case's procedures may not be visible yet immediately after createCaseSummary
    // under concurrent load - retry before treating it as genuinely empty. Wider than
    // pollUntilFound's default (5x/2s) since this specific lookup was still seeing
    // "no performed items" failures within that window under heavier concurrent load.
    const procedures = await this.pollUntilFound(
      async () => {
        const response = await this.runWebServiceRequest('', `ScheduledCaseProcedure/GetScheduledProcedures/${caseSummaryId}/false`, 'GET');
        const result = Array.isArray(response.data) ? (response.data as Record<string, unknown>[]) : JSON.parse(response.raw);
        return result.length > 0 ? result : undefined;
      },
      8,
      3000
    );
    return procedures ?? [];
  }

  /**
   * Port of ReUsableWebserviceUtils.getICDCode (/ICDCodeClassification/GetICDCodeClassifications, POST).
   * Searches by the first 3 characters of icdCode (matching the Java original), returning
   * the full classification array for the caller to find an exact icdCode match within.
   */
  protected async getICDCodeClassifications(icdCode: string): Promise<Record<string, unknown>[]> {
    const response = await this.runWebServiceRequest(`"${icdCode.slice(0, 3)}"`, '/ICDCodeClassification/GetICDCodeClassifications', 'POST');
    return Array.isArray(response.data) ? (response.data as Record<string, unknown>[]) : JSON.parse(response.raw);
  }

  /** Port of ReUsableWebserviceUtils.performChargeEntry (CaseToCharge/SavePerformedProcedure/, POST). */
  protected async performChargeEntry(requestBody: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    const response = await this.runWebServiceRequest(requestBody, 'CaseToCharge/SavePerformedProcedure/', 'POST');
    return JSON.parse(response.raw);
  }

  /** Port of ReUsableWebserviceUtils.performCasesToCode (CaseToCode/SavePerformedItems, POST). */
  protected async performCasesToCode(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.runWebServiceRequest(body, 'CaseToCode/SavePerformedItems', 'POST');
    return JSON.parse(response.raw);
  }

  /**
   * Port of ReUsableWebserviceUtils.getPhysicianOpNotesDetails (/OpNoteConfiguration/Names, GET).
   * Caches the found opNoteId under Keys.KEY_PHYSICIAN_OP_NOTES_ID.
   */
  protected async getPhysicianOpNotesDetails(name: string): Promise<boolean> {
    const response = await this.runWebServiceRequest('', '/OpNoteConfiguration/Names', 'GET');
    const opNotes = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const opNote = (opNotes as Record<string, unknown>[]).find((o) => String(o.opNoteName).toLowerCase() === name.toLowerCase());
    if (!opNote) return false;

    this.responseCache.put(Keys.KEY_PHYSICIAN_OP_NOTES_ID, opNote.opNoteId);
    return true;
  }

  /** Port of ReUsableWebserviceUtils.getPhysicianOpNotesById (/OpNoteDocumentation/{opNotesId}, GET). */
  protected async getPhysicianOpNotesById(opNotesId: string): Promise<Record<string, unknown>> {
    const response = await this.runWebServiceRequest('', `/OpNoteDocumentation/${opNotesId}`, 'GET');
    return typeof response.data === 'object' && response.data !== null ? (response.data as Record<string, unknown>) : JSON.parse(response.raw);
  }

  /** Port of ReUsableWebserviceUtils.getDictionaryItems (Dictionary/v2/{dictionaryItemId}, GET). */
  protected async getDictionaryItems(dictionaryItemId: string): Promise<Record<string, unknown>[]> {
    const response = await this.runWebServiceRequest('', `Dictionary/v2/${dictionaryItemId}`, 'GET');
    return Array.isArray(response.data) ? (response.data as Record<string, unknown>[]) : JSON.parse(response.raw);
  }

  /**
   * Port of ReUsableWebserviceUtils.getCaseFlagDetails (/CaseFlag/Config, GET).
   * Case flags are created by a separate seed-data row (createCaseFlags) that often runs
   * concurrently with the row consuming it in the same batch, so a fresh flag may not be
   * visible yet - retry briefly before treating it as genuinely missing.
   */
  protected async getCaseFlagDetails(caseFlagName: string): Promise<Record<string, unknown>> {
    const caseFlag = await this.pollUntilFound(async () => {
      const response = await this.runWebServiceRequest('', '/CaseFlag/Config', 'GET');
      const caseFlags = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
      return findByField(caseFlags as Record<string, unknown>[], 'caseFlagName', caseFlagName);
    });
    if (!caseFlag) {
      throw new Error(`getCaseFlagDetails: no case flag found with name "${caseFlagName}"`);
    }
    return caseFlag;
  }

  private getUserSessionOrg(response: unknown, orgName: string): string {
    const arr = Array.isArray(response) ? response : JSON.parse(String(response));
    const childOrgs = arr[0]?.childOrgs ?? [];
    const match = findByField(childOrgs as Record<string, unknown>[], 'name', orgName);
    if (!match) {
      throw new Error(`Organization not found in UserOrgMap response - ${orgName}`);
    }
    return String(match.organizationId);
  }
}
