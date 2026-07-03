import { WebserviceUtils } from './webserviceUtils';
import { ResponseCache } from './responseCache';
import { SeedData } from '../../seeddata/seedData';
import { generateRandomNumeric, addDate } from '../../utils/reusableUtils';
import * as Keys from './iWebServiceResponseKeys';
import { updateField } from '../../templates/templateLoader';

export interface CreateJustAPatientParams {
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  procedureDt: string;
  patientGender?: string;
  religion?: string;
  ethnicity?: string;
  race?: string;
  // The following are supported by the Java original via dedicated
  // sub-builders (updatePatientAddressDetails, updatePatientAdditionalDetails,
  // updatePatientPhoneDetails, updatePatientEmergencyContactDetails,
  // updatePatientEmployerDetails - ReUsableWebserviceUtils.java L5922-6100+)
  // which are NOT yet ported. Real seed-data rows observed so far leave these
  // blank, so createJustAPatient throws if any are non-blank rather than
  // silently dropping that data.
  patientAddressDetails?: string;
  patientAdditionalDetails?: string;
  patientPhoneDetails?: string;
  patientEmergencyContactDetails?: string;
  patientEmployerDetails?: string;
}

function isBlank(v: string | undefined): boolean {
  return v == null || v.trim() === '' || v.trim().toLowerCase() === 'blank';
}

/**
 * Port of com.client.webservice.WebServiceClient.
 *
 * Java's WebServiceClient.callWebService(SeedData) dispatches ~15+ operation
 * types via a switch statement (Room Details, PatientCreation,
 * InsuranceCreation, WorklistAddition, ConsentsCreation, ...), several of
 * which (PatientCreation in particular) chain 10+ sequential sub-steps with
 * real ID output-chaining (patient -> case -> worklist/consents/discharge).
 *
 * This port currently implements the dispatcher plus ONE fully-ported
 * operation (`Room Details` / createNewRoom, WebServiceClient.java lines
 * 370-411) end-to-end, including session handling and template mutation, to
 * validate the pattern against a real backend. The remaining operations are
 * intentionally left as explicit not-implemented stubs (logged, not thrown,
 * so a single unimplemented operation doesn't abort processing of the rest
 * of a row) rather than guessed at, since getting the ID-chaining logic
 * wrong would silently corrupt seeded data.
 *
 * One instance of WebServiceClient is created PER ROW (see ResponseCache),
 * not shared across concurrent rows.
 */
export class WebServiceClient extends WebserviceUtils {
  private static readonly UNIMPLEMENTED_OPERATIONS = new Set([
    'InsuranceCreation', // WebServiceClient.java createInsurance, ~L184-555 in ReUsableWebserviceUtils
    'PatientCreation', // WebServiceClient.java patientOperations, ~L557-672+ chain
    'PeriodBatchCreation',
    'FeeScheduleCreation',
    'WorklistAddition',
    'ConsentsCreation',
    'MedicationCreation',
    'createPreferenceCards',
    'createPhysicianOpNotes',
    'addNewTransactionCode',
    'createNewDiscounts',
    'createInsuranceContract',
    'updateStateReportPhysician',
    'createDischargeInstructions',
  ]);

  constructor(baseURL: string, responseCache: ResponseCache, templatesDir: string) {
    super(baseURL, responseCache, templatesDir);
  }

  /**
   * Port of WebServiceClient.callWebService(SeedData). Iterates the row's
   * operations in Excel column order (SeedData.operations is a Map, which
   * preserves insertion order in JS, matching the Java LinkedHashMap
   * guarantee the original code explicitly relies on).
   */
  async callWebService(sd: SeedData): Promise<void> {
    for (const [operationName, params] of sd.operations) {
      switch (operationName) {
        case 'Room Details':
        case 'RoomDetails':
          await this.createNewRoom(params.get('facility') ?? '', params.get('roomName') ?? '');
          break;

        default:
          if (WebServiceClient.UNIMPLEMENTED_OPERATIONS.has(operationName)) {
            console.warn(`[WebServiceClient] Operation not yet ported, skipping: ${operationName} (testCase=${sd.testCase}, row=${sd.rowNumber})`);
          } else {
            console.warn(`[WebServiceClient] Unknown operation, skipping: ${operationName} (testCase=${sd.testCase}, row=${sd.rowNumber})`);
          }
      }
    }
  }

  /** Port of WebServiceClient.createNewRoom (WebServiceClient.java L370-411). */
  async createNewRoom(facility: string, roomNames: string): Promise<void> {
    await this.createSession(facility);

    for (const roomName of roomNames.split(';')) {
      if (!roomName) continue;

      // API1: create room type
      const roomTypeId = Number(generateRandomNumeric(9));
      const roomTypeDesc = `RTyp ${roomName}`;
      let roomTypeBody = this.templates.load<Record<string, unknown>>('AddRoomType.json');
      roomTypeBody = updateField(roomTypeBody, 'roomTypeId', roomTypeId);
      roomTypeBody = updateField(roomTypeBody, 'roomTypeDesc', roomTypeDesc);
      roomTypeBody = updateField(roomTypeBody, 'quickCode', roomTypeDesc);
      await this.runWebServiceRequest(roomTypeBody, '/RoomType/Add', 'POST');

      // API2: create room, referencing the roomTypeId just created and the org id from session
      const roomId = Number(generateRandomNumeric(9));
      const orgId = Number(this.responseCache.getString(Keys.KEY_ORG_ID));
      let roomBody = this.templates.load<Record<string, unknown>>('AddRoom.json');
      roomBody = updateField(roomBody, 'roomTypeId', roomTypeId);
      roomBody = updateField(roomBody, 'roomId', roomId);
      roomBody = updateField(roomBody, 'organizationId', orgId);
      roomBody = updateField(roomBody, 'name', roomName);
      roomBody = updateField(roomBody, 'quickCode', roomName);
      await this.runWebServiceRequest(roomBody, '/Room/Add', 'POST');
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.createjustApatient (ReUsableWebserviceUtils.java
   * L420-495). Covers the core patient-creation payload (name, DOB, gender,
   * ethnicity, religion, race, account number, procedure date); the five
   * address/contact/additional/employer detail sub-builders are not yet
   * ported (see CreateJustAPatientParams) and this throws if any of those
   * fields are populated rather than silently omitting the data.
   */
  async createJustAPatient(params: CreateJustAPatientParams): Promise<void> {
    for (const detailField of [
      'patientAddressDetails',
      'patientAdditionalDetails',
      'patientPhoneDetails',
      'patientEmergencyContactDetails',
      'patientEmployerDetails',
    ] as const) {
      if (!isBlank(params[detailField])) {
        throw new Error(
          `createJustAPatient: ${detailField} is not yet ported (ReUsableWebserviceUtils.java update${detailField[0].toUpperCase()}${detailField.slice(1)} equivalent) - value was "${params[detailField]}"`
        );
      }
    }

    const relURL = '/PatientData/Gemini/CreatePatient/2030';
    let body = this.templates.load<Record<string, unknown>>('CreatePatient.json');

    const accountNumber = Number(generateRandomNumeric(13));
    const procedureDt = addDate(params.procedureDt, 'yyyy-MM-dd');

    body = updateField(body, 'firstName', params.firstName);
    body = updateField(body, 'lastName', params.lastName);
    if (!isBlank(params.dateOfBirth)) {
      body = updateField(body, 'dateOfBirth', params.dateOfBirth);
    }
    body = updateField(body, 'accountNumber', accountNumber);
    body = updateField(body, 'procedureDt', `${procedureDt}T00:00:00-0500`);
    body = updateField(body, 'fullName', `${params.firstName} ${params.lastName}`);
    body = updateField(body, 'fullNameWithTitle', `${params.firstName} ${params.lastName}`);

    if (!isBlank(params.patientGender)) {
      body = updateField(body, 'gender', params.patientGender);
    }

    if (params.ethnicity?.toLowerCase() === 'hispanic') {
      body = updateField(updateField(body, 'ethnicityId', 1), 'ethnicity', 'Hispanic');
    } else if (params.ethnicity?.toLowerCase() === 'non-hispanic') {
      body = updateField(updateField(body, 'ethnicityId', 2), 'ethnicity', 'Non-Hispanic');
    }

    if (!isBlank(params.religion)) {
      const found = await this.getDictionaryDetails('Religion', params.religion!);
      if (found) {
        body = updateField(updateField(body, 'religionId', this.responseCache.get<number>(Keys.KEY_DICTIONARY_ITEM_ID)), 'religion', params.religion);
      }
    }

    if (!isBlank(params.race)) {
      const found = await this.getDictionaryDetails('Race', params.race!);
      if (found) {
        body = updateField(updateField(body, 'raceId', this.responseCache.get<number>(Keys.KEY_DICTIONARY_ITEM_ID)), 'race', params.race);
      }
    }

    body = updateField(body, 'middleInitial', 'M');

    const response = await this.runWebServiceRequest(body, relURL, 'POST');
    this.responseCache.put(Keys.KEY_CREATE_PATIENT_RESPONSE, response.raw);
  }
}
