import { WebserviceUtils } from './webserviceUtils';
import { ResponseCache } from './responseCache';
import { SeedData } from '../../seeddata/seedData';
import { generateRandomNumeric, addDate, getLaterality, encodeString2Base64 } from '../../utils/reusableUtils';
import * as Keys from './iWebServiceResponseKeys';
import { updateField, setPath, getPath, findByField } from '../../templates/templateLoader';

export interface CreateCaseSummaryParams {
  physicianUser: string;
  roomName: string;
  startTime: string;
  endTime: string;
  appointmentType: string;
  preferenceCardName?: string;
  cptCode: string;
  lterality?: string;
  preOpDiagnosisCode?: string;
  anesthesiaType?: string;
  dos: string;
  guarantorFirstName?: string;
  guarantorLastName?: string;
  guarantorDateOfBirth?: string;
  guarantorAdditionalDetails?: string;
  guarantorCountry?: string;
  guarantorIsActive?: string;
  primaryGuarantor?: string;
  secondaryGuarantor?: string;
  Carriername?: string;
  RelationshiptoSubscriber?: string;
  InsurancefirstName?: string;
  InsurancelastName?: string;
  gender?: string;
  Subscriberid?: string;
  insuranceAdditionalDetails?: string;
  caseFlags?: string;
}

export interface CreateInsuranceParams {
  facility: string;
  insuranceName: string;
  electronicClaim?: string;
  paperForm?: string;
  planName: string;
  insuranceClassification: string;
  officeName: string;
  line1: string;
  city: string;
  contactName: string;
  phone: string;
  zip: string;
  extendedZip: string;
  State: string;
  generateTrue: boolean;
  contractName?: string;
  ePayerCode?: string;
}

export interface CreateJustAPatientParams {
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  procedureDt: string;
  patientGender?: string;
  religion?: string;
  ethnicity?: string;
  race?: string;
  // patientAddressDetails/patientAdditionalDetails/patientPhoneDetails are now
  // parsed (see parsePatientAddressDetails/parsePatientPhoneDetails/
  // buildPatientAdditionalDetailsUpdates). The remaining two (contact/employer)
  // are supported by the Java original via dedicated sub-builders
  // (updatePatientEmergencyContactDetails, updatePatientEmployerDetails -
  // ReUsableWebserviceUtils.java L5922-6100+) which are NOT yet ported.
  // createJustAPatient throws if either of those two is non-blank rather
  // than silently dropping that data.
  patientAddressDetails?: string;
  patientAdditionalDetails?: string;
  patientPhoneDetails?: string;
  patientEmergencyContactDetails?: string;
  patientEmployerDetails?: string;
}

function isBlank(v: string | undefined): boolean {
  return v == null || v.trim() === '' || v.trim().toLowerCase() === 'blank';
}

interface PatientAddress {
  line1: string;
  line2: string;
  city: string;
  country: string;
}

/** "UnitedStates" -> "United States"; leaves already-spaced values untouched. */
function normalizeCountry(value: string): string {
  return value.includes(' ') ? value : value.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Parses the seed-data patientAddressDetails column, a comma-separated string
 * observed as: line1, line2, addressType, city, stateAbbr, stateName, country, zip, suffix
 * (e.g. "3500 Deer Creek Road,Creek Road,RESIDENTIAL,Palo Alto2,AK,Texas,UnitedStates,12345,0125").
 *
 * The live CreatePatient response's patient.address object only has
 * {line1, line2, city, country} - no addressType/state/suffix slot - so
 * addressType (index 2), stateAbbr/stateName (indices 4-5), and the trailing
 * suffix (index 8) are intentionally dropped rather than guessed into a
 * field the API doesn't have. zip is a top-level patient field, not nested
 * under address, per the same sample response.
 */
function parsePatientAddressDetails(raw: string): { address: PatientAddress; zip: string | undefined } {
  const parts = raw.split(',').map((p) => p.trim());
  return {
    address: {
      line1: parts[0] ?? '',
      line2: parts[1] ?? '',
      city: parts[3] ?? '',
      country: normalizeCountry(parts[6] ?? ''),
    },
    zip: parts[7],
  };
}

/**
 * Port of ReUsableWebserviceUtils.updatePatientPhoneDetails - comma-separated
 * asphoneNumber,phoneType. Matches Java's behavior of reading only the first
 * two comma-parts regardless of how many total parts the cell has.
 */
function parsePatientPhoneDetails(raw: string): { phoneNumber: string | null; phoneType: string | null } {
  const parts = raw.split(',').map((p) => p.trim());
  const phoneNumber = parts[0];
  const phoneType = parts[1];
  return {
    phoneNumber: isBlank(phoneNumber) ? null : phoneNumber,
    phoneType: isBlank(phoneType) ? null : phoneType,
  };
}

const MARITAL_STATUS_IDS: Record<string, number> = {
  divorced: 1,
  'legally separated': 2,
  'life partner': 3,
  married: 4,
  single: 5,
  unknown: 6,
  widowed: 7,
};

/** Port of ReUsableWebserviceUtils.getMaritalStatusId - a fixed lookup table, not a dictionary API call. */
function getMaritalStatusId(maritalStatus: string): number {
  const id = MARITAL_STATUS_IDS[maritalStatus.toLowerCase()];
  if (id == null) {
    throw new Error(`getMaritalStatusId: "${maritalStatus}" is not a valid marital status`);
  }
  return id;
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
  private static readonly UNIMPLEMENTED_OPERATIONS = new Set<string>([]);

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

        case 'InsuranceCreation':
          await this.createInsurance({
            facility: params.get('facility') ?? '',
            insuranceName: params.get('insuranceName') ?? '',
            electronicClaim: params.get('electronicClaim'),
            paperForm: params.get('paperForm'),
            planName: params.get('planName') ?? '',
            insuranceClassification: params.get('insuranceClassification') ?? '',
            officeName: params.get('officeName') ?? '',
            line1: params.get('line1') ?? '',
            city: params.get('city') ?? '',
            contactName: params.get('contactName') ?? '',
            phone: params.get('phone') ?? '',
            zip: params.get('zip') ?? '',
            extendedZip: params.get('extendedZip') ?? '',
            State: params.get('State') ?? '',
            generateTrue: (params.get('generateTrue') ?? '').toLowerCase() === 'true',
            contractName: params.get('contractName'),
            ePayerCode: params.get('ePayerCode'),
          });
          break;

        case 'PeriodBatchCreation':
          await this.createPeriodBatch(
            params.get('userName') ?? '',
            params.get('password') ?? '',
            params.get('facility') ?? '',
            params.get('periodName') ?? '',
            params.get('periodBeginDate') ?? '',
            params.get('periodEndDate') ?? '',
            (params.get('isActive') ?? '').toLowerCase() === 'true',
            params.get('batchName') ?? ''
          );
          break;

        case 'FeeScheduleCreation':
          await this.insertFeeSchedule(
            params.get('Username') ?? '',
            params.get('Password') ?? '',
            params.get('Facility') ?? '',
            params.get('CPTCode') ?? '',
            params.get('Amount') ?? '',
            params.get('BillableStatus') ?? ''
          );
          break;

        case 'WorklistAddition':
          await this.createWorklist(
            params.get('facility') ?? '',
            params.get('worklistType') ?? '',
            params.get('worklistName') ?? '',
            params.get('generalFlag') ?? '',
            params.get('painFlag') ?? '',
            params.get('giFlag') ?? '',
            params.get('eyeFlag') ?? '',
            params.get('laserFlag') ?? '',
            params.get('questions')
          );
          break;

        case 'ConsentsCreation':
          await this.createConsents(
            params.get('facility') ?? '',
            params.get('consentName') ?? '',
            params.get('generalFlag') ?? '',
            params.get('painFlag') ?? '',
            params.get('giFlag') ?? '',
            params.get('eyeFlag') ?? '',
            params.get('laserFlag') ?? '',
            params.get('physicianScheduleFlag') ?? '',
            params.get('procdeureScheduleFlag') ?? '',
            params.get('diagnosisScheduleFlag') ?? '',
            params.get('consentStatementText'),
            params.get('signeeDetails')
          );
          break;

        case 'createDischargeInstructions':
          await this.createDischargeInstructions(
            params.get('facility') ?? '',
            params.get('configurationName') ?? '',
            params.get('generalFlag') ?? '',
            params.get('painFlag') ?? '',
            params.get('giFlag') ?? '',
            params.get('eyeFlag') ?? '',
            params.get('laserFlag') ?? ''
          );
          break;

        case 'PatientCreation':
          await this.createSession(params.get('facility') ?? '', params.get('UserName'), params.get('Password'));
          if (!isBlank(params.get('patientsearchstr'))) {
            const fullName = `${params.get('firstName') ?? ''} M. ${params.get('lastName') ?? ''}`;
            await this.getPatientObjFromName(params.get('patientsearchstr')!, fullName);
          } else {
            await this.createJustAPatient({
              firstName: params.get('firstName') ?? '',
              lastName: params.get('lastName') ?? '',
              dateOfBirth: params.get('dateOfBirth'),
              procedureDt: params.get('procedureDt') ?? '',
              patientGender: params.get('patientGender') ?? params.get('gender'),
              religion: params.get('religion'),
              ethnicity: params.get('ethnicity'),
              race: params.get('race'),
              patientAddressDetails: params.get('patientAddressDetails'),
              patientAdditionalDetails: params.get('patientAdditionalDetails'),
              patientPhoneDetails: params.get('patientPhoneDetails'),
              patientEmergencyContactDetails: params.get('patientEmergencyContactDetails'),
              patientEmployerDetails: params.get('patientEmployerDetails'),
            });
          }
          await this.createCaseSummary({
            physicianUser: params.get('physicianUser') ?? '',
            roomName: params.get('roomName') ?? '',
            startTime: params.get('startTime') ?? '',
            endTime: params.get('endTime') ?? '',
            appointmentType: params.get('appointmentType') ?? '',
            preferenceCardName: params.get('preferenceCardName'),
            cptCode: params.get('cptCode') ?? '',
            lterality: params.get('lterality'),
            preOpDiagnosisCode: params.get('preOpDiagnosisCode'),
            anesthesiaType: params.get('anesthesiaType'),
            dos: params.get('procedureDt') ?? '',
            guarantorFirstName: params.get('guarantorFirstName'),
            guarantorLastName: params.get('guarantorLastName'),
            guarantorDateOfBirth: params.get('guarantorDateOfBirth'),
            guarantorAdditionalDetails: params.get('guarantorAdditionalDetails'),
            guarantorCountry: params.get('guarantorCountry'),
            guarantorIsActive: params.get('guarantorIsActive'),
            primaryGuarantor: params.get('primaryGuarantor'),
            secondaryGuarantor: params.get('secondaryGuarantor'),
            Carriername: params.get('Carriername'),
            RelationshiptoSubscriber: params.get('RelationshiptoSubscriber'),
            InsurancefirstName: params.get('InsurancefirstName'),
            InsurancelastName: params.get('InsurancelastName'),
            gender: params.get('gender'),
            Subscriberid: params.get('Subscriberid'),
            insuranceAdditionalDetails: params.get('insuranceAdditionalDetails'),
            caseFlags: params.get('caseFlags'),
          });
          if (!isBlank(params.get('patientAddressDetails')) && !isBlank(params.get('Carriername'))) {
            await this.checkPatientInsuranceEligibility();
          }
          if (!isBlank(params.get('WorklistWithDepartment'))) {
            throw new Error(
              `PatientCreation: WorklistWithDepartment mapping is not yet ported (addWorklistToPatient equivalent) - value was "${params.get(
                'WorklistWithDepartment'
              )}"`
            );
          } else if (!isBlank(params.get('preferenceCardName')) && !isBlank(params.get('ImplantsAndProsthesisByInventory'))) {
            throw new Error(
              `PatientCreation: implant-to-patient mapping is not yet ported (mapImplantToPatient equivalent) - preferenceCardName="${params.get(
                'preferenceCardName'
              )}"`
            );
          }
          if (!isBlank(params.get('PreOPmedicationtemplates'))) {
            await this.addMedication(params.get('physicianUser') ?? '', params.get('PreOPmedicationtemplates')!, 'Pre-Operative');
          }
          if (!isBlank(params.get('OPmedicationtemplates'))) {
            await this.addMedication(params.get('physicianUser') ?? '', params.get('OPmedicationtemplates')!, 'Operative');
          }
          if (!isBlank(params.get('Recovmedicationtemplates'))) {
            await this.addMedication(params.get('physicianUser') ?? '', params.get('Recovmedicationtemplates')!, 'Recovery');
          }
          if (!isBlank(params.get('DischargeByUserName'))) {
            await this.dischargePatient(params.get('DischargeByUserName')!, params.get('procedureDt') ?? '', params.get('preoperativedetails'));
          }
          if (!isBlank(params.get('signInDepartment'))) {
            await this.signPatientDepartments(params.get('signInDepartment')!);
          }
          if (!isBlank(params.get('opNotes'))) {
            await this.addOPNotesToPatient(params.get('opNotes')!);
          }
          if (!isBlank(params.get('DiagnosisCode'))) {
            await this.performPatientCasesToCode(params.get('DiagnosisCode')!);
          }
          if (!isBlank(params.get('PeriodName'))) {
            await this.performPatientChargeEntry(params.get('PeriodName')!, params.get('BatchName') ?? '', params.get('Amounts') ?? '');
          }
          if (!isBlank(params.get('ArrivalTime'))) {
            await this.checkInPatientArrival(params.get('ArrivalTime')!);
          }
          if (!isBlank(params.get('CancelCase'))) {
            await this.cancelPatient(params.get('CancelCase')!);
          }
          break;

        case 'createInsuranceContract':
          await this.createInsuranceContract(
            params.get('username') ?? '',
            params.get('password') ?? '',
            params.get('facility') ?? '',
            params.get('insuranceContractName') ?? '',
            params.get('effectiveDate') ?? '',
            params.get('expirationDate') ?? '',
            params.get('contractType') ?? '',
            params.get('percentOfBilledCharge') ?? '',
            params.get('transactionCodeName') ?? '',
            params.get('writeOffGroupId') ?? '',
            params.get('writeOffReasonId') ?? '',
            params.get('procedure1') ?? '',
            params.get('procedure2') ?? '',
            params.get('procedure3') ?? '',
            params.get('procedure4') ?? '',
            params.get('procedure5') ?? '',
            params.get('addtionalProcedure') ?? '',
            params.get('groupIndx') ?? '',
            params.get('reimbursement') ?? ''
          );
          break;

        case 'createDictionaryItem':
          await this.createDictionaryItem(
            params.get('userName') ?? '',
            params.get('password') ?? '',
            params.get('facility') ?? '',
            params.get('Dictionaryname') ?? '',
            params.get('DictionaryitemName') ?? '',
            params.get('value') ?? ''
          );
          break;

        case 'createCaseFlags':
          await this.createCaseFlags(
            params.get('facility') ?? '',
            params.get('caseFlagName') ?? '',
            params.get('abbreviation') ?? '',
            params.get('color') ?? '',
            params.get('flagVisibility') ?? ''
          );
          break;

        case 'createPhysicianOpNotes':
          await this.createPhysicianOpNotes(
            params.get('userName') ?? '',
            params.get('password') ?? '',
            params.get('facility') ?? '',
            params.get('Ordername') ?? '',
            params.get('Physicianname') ?? '',
            params.get('Opnotetext') ?? ''
          );
          break;

        case 'createNewDiscounts':
          await this.createDiscounts(
            params.get('userName') ?? '',
            params.get('password') ?? '',
            params.get('facility') ?? '',
            params.get('discountName') ?? '',
            params.get('writeOffGroupCode') ?? '',
            params.get('WriteOffReasonCode') ?? '',
            params.get('transactionCodeName') ?? '',
            params.get('discountpercent') ?? ''
          );
          break;

        case 'createMessageTemplate':
          await this.createMessageTemplate(
            params.get('userName') ?? '',
            params.get('password') ?? '',
            params.get('facilityName') ?? '',
            params.get('templateName') ?? '',
            params.get('desktop') ?? '',
            params.get('messageType') ?? '',
            params.get('body') ?? '',
            params.get('emailSubject') ?? ''
          );
          break;

        case 'MedicationCreation':
          await this.createMedication(
            params.get('Username') ?? '',
            params.get('Password') ?? '',
            params.get('Facility') ?? '',
            params.get('Medication') ?? '',
            params.get('searchString') ?? '',
            params.get('FullMedication') ?? '',
            params.get('Department'),
            params.get('Speciality'),
            params.get('TemplateName') ?? '',
            params.get('isTitrated') ?? ''
          );
          break;

        case 'createPreferenceCards':
          await this.createPreferenceCards(
            params.get('facility') ?? '',
            params.get('preferenceCardNames') ?? '',
            params.get('caseSpecialtiy') ?? '',
            params.get('appointmentTypeValue') ?? '',
            params.get('physician') ?? '',
            params.get('anesthesiaTypeValue') ?? '',
            params.get('automaticCaseFlags') ?? '',
            params.get('physicianOrders') ?? '',
            params.get('opNotes') ?? '',
            params.get('consents') ?? '',
            params.get('dischargeInstructions') ?? '',
            params.get('preAdmissionQxWorklists') ?? '',
            params.get('preAdmissionInstructionsWorklists') ?? '',
            params.get('preOperativeWorklists') ?? '',
            params.get('operativeWorklists') ?? '',
            params.get('phase1Worklists') ?? '',
            params.get('phase2Worklists') ?? '',
            params.get('phase3Worklists') ?? '',
            params.get('recoveryWorklist') ?? '',
            params.get('postoperativeQXWorklists') ?? '',
            params.get('implantNames') ?? '',
            params.get('manfacturerNames') ?? '',
            params.get('size') ?? '',
            params.get('lotNum') ?? '',
            params.get('serialNum') ?? '',
            params.get('expiration') ?? '',
            params.get('referenceNum') ?? '',
            params.get('quantity') ?? '',
            params.get('implantnotes') ?? '',
            params.get('supplyName') ?? '',
            params.get('prOpen') ?? '',
            params.get('prHold') ?? '',
            params.get('orOpen') ?? '',
            params.get('orHold') ?? '',
            params.get('p3Open') ?? '',
            params.get('p3Hold') ?? '',
            params.get('supplyNotes') ?? '',
            params.get('equipmentNames') ?? '',
            params.get('serialNumbers') ?? '',
            params.get('equipmentNotes') ?? '',
            params.get('cptCodes') ?? ''
          );
          break;

        case 'addPaymentTransaction':
          await this.addPaymentTransaction(
            params.get('writeOffGroupCode') ?? '',
            params.get('WriteOffReasonCode') ?? '',
            params.get('amount') ?? '',
            params.get('transactionCodeName') ?? ''
          );
          break;

        case 'addNewWriteoffTransaction':
          await this.addNewWriteoffTransaction(
            params.get('writeOffGroupCode') ?? '',
            params.get('WriteOffReasonCode') ?? '',
            params.get('amount') ?? '',
            params.get('transactionCodeName') ?? ''
          );
          break;

        case 'updateSuppliesToContract':
          await this.updateSuppliesToContract(
            params.get('facility') ?? '',
            params.get('contractName') ?? '',
            params.get('revenueCode') ?? '',
            params.get('revCodePostingMethod') ?? '',
            params.get('revCodefeeOrCostPercentage') ?? '',
            params.get('supplyCostMin') ?? '',
            params.get('supplyCostMax') ?? '',
            params.get('supplyCostPostingMethod') ?? '',
            params.get('supplyCostfeeOrCostPercentage') ?? '',
            params.get('supplyCategory') ?? '',
            params.get('supplyCategoryPostingMethod') ?? '',
            params.get('supplyCategoryfeeOrCostPercentage') ?? '',
            params.get('supplyItemName') ?? '',
            params.get('supplyItemPostingMethod') ?? '',
            params.get('supplyItemfeeOrCostPercentage') ?? ''
          );
          break;

        case 'createAnesthesiaOrders':
          await this.createAnesthesiaOrders(
            params.get('facility') ?? '',
            params.get('ordername') ?? '',
            params.get('department') ?? '',
            params.get('departmentOrderstext') ?? ''
          );
          break;

        case 'createBlockNote':
          await this.createBlockNotes(
            params.get('facility') ?? '',
            params.get('blockNames') ?? '',
            params.get('rooms') ?? '',
            params.get('physicians') ?? '',
            params.get('dates') ?? '',
            params.get('startTimes') ?? '',
            params.get('endTimes') ?? '',
            params.get('specialitys') ?? '',
            params.get('blockColors') ?? '',
            params.get('blockOuts') ?? ''
          );
          break;

        case 'createPhysicianOrders':
          await this.createPhysicianOrders(
            params.get('userName') ?? '',
            params.get('password') ?? '',
            params.get('facility') ?? '',
            params.get('Ordername') ?? '',
            params.get('Physician') ?? '',
            params.get('Department') ?? '',
            params.get('DepartmentOrderstext') ?? ''
          );
          break;

        case 'createAnesthesiaBlock':
          await this.createAnesthesiaBlock(params.get('facility') ?? '', params.get('anesthesiBlockNote') ?? '', params.get('blockNoteTexArea') ?? '');
          break;

        case 'createNewuser':
          await this.createUsers(
            params.get('userName') ?? '',
            params.get('password') ?? '',
            params.get('facility') ?? '',
            params.get('firstName') ?? '',
            params.get('middleInitial') ?? '',
            params.get('lastName') ?? '',
            params.get('businessfacility') ?? '',
            params.get('profileName') ?? '',
            params.get('roleName') ?? '',
            params.get('emailAddress'),
            params.get('title') ?? '',
            params.get('IsEnterprise')
          );
          break;

        case 'addNewTransactionCode':
          await this.createNewTransactionCodes(
            params.get('userName') ?? '',
            params.get('password') ?? '',
            params.get('facility') ?? '',
            params.get('transactionCodeName') ?? '',
            params.get('transactiontype') ?? ''
          );
          break;

        // The following 17 operation types have 0 rows in the actual seed data (verified by
        // counting SeedData.operations.keys() usage across the full sheet). Rather than silently
        // falling through to the generic "Unknown operation" warning below, they throw a clear
        // "not yet ported" error so a future seed-data change that starts using one of them fails
        // loudly instead of being silently skipped.
        case 'FeeScheduleFreeTextCreation':
        case 'UpdateFacilityFeatureMapping':
        case 'addNewDebitTransaction':
        case 'createConfigDictionaries':
        case 'createEquipment':
        case 'insertWorklistdictionary':
        case 'insertdischarge_status_related_dictionary':
        case 'insertmedication_related_dictionary':
        case 'insertpatient_related_dictionary':
        case 'insertquestion_related_dictionary':
        case 'insertspecimen_related_dictionary':
        case 'manualRemittancePosting':
        case 'updateStateReportEthnicity':
        case 'updateStateReportInsurance':
        case 'updateStateReportLanguage':
        case 'updateStateReportPhysician':
        case 'updateStateReportRace':
          throw new Error(`${operationName}: not yet ported (0 rows use this operation in the current seed data)`);

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
   * ethnicity, religion, race, account number, procedure date, address); the
   * remaining four contact/additional/employer detail sub-builders are not
   * yet ported (see CreateJustAPatientParams) and this throws if any of
   * those fields are populated rather than silently omitting the data.
   */
  async createJustAPatient(params: CreateJustAPatientParams): Promise<void> {
    for (const detailField of ['patientEmergencyContactDetails', 'patientEmployerDetails'] as const) {
      if (!isBlank(params[detailField])) {
        throw new Error(
          `createJustAPatient: ${detailField} is not yet ported (ReUsableWebserviceUtils.java update${detailField[0].toUpperCase()}${detailField.slice(1)} equivalent) - value was "${params[detailField]}"`
        );
      }
    }

    if (isBlank(params.lastName)) {
      throw new Error(
        `createJustAPatient: lastName is required by the API but is blank in the seed-data row (firstName="${params.firstName}") - this looks like an unresolved seed-data placeholder rather than real patient data`
      );
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
      if (params.patientGender!.length > 20) {
        throw new Error(
          `createJustAPatient: patientGender "${params.patientGender}" exceeds the API's 20-character limit - this looks like an unresolved seed-data placeholder rather than a real gender value`
        );
      }
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

    if (!isBlank(params.patientPhoneDetails)) {
      const phoneDetails = parsePatientPhoneDetails(params.patientPhoneDetails!);
      body = updateField(body, 'mpiPatientPhone', phoneDetails);
    }

    if (!isBlank(params.patientAdditionalDetails)) {
      body = await this.applyPatientAdditionalDetails(body, params.patientAdditionalDetails!, params.firstName, params.lastName);
    }

    // Java's createjustApatient always overrides middleInitial to "M" after
    // updatePatientAdditionalDetails runs, so any middleInitial set above is discarded -
    // only fullName/fullNameWithTitle keep the additionalDetails-derived middle initial.
    body = updateField(body, 'middleInitial', 'M');

    if (!isBlank(params.patientAddressDetails)) {
      const { address, zip } = parsePatientAddressDetails(params.patientAddressDetails!);
      body = updateField(body, 'address', address);
      if (zip) {
        body = updateField(body, 'zip', zip);
      }
    }

    const response = await this.runWebServiceRequest(body, relURL, 'POST');
    this.responseCache.put(Keys.KEY_CREATE_PATIENT_RESPONSE, response.raw);
  }

  /** Port of ReUsableWebserviceUtils.getLanguageId (Dictionary/v2/150/All, GET) - a fixed dictionary id, not resolved by name. */
  private async getLanguageId(language: string): Promise<number> {
    const response = await this.runWebServiceRequest('', 'Dictionary/v2/150/All', 'GET');
    const items = Array.isArray(response.data) ? response.data : JSON.parse(response.raw);
    const item = findByField(items as Record<string, unknown>[], 'value', language);
    if (!item) {
      throw new Error(`getLanguageId: "${language}" is not a valid language`);
    }
    return Number(item.id);
  }

  /**
   * Port of ReUsableWebserviceUtils.updatePatientAdditionalDetails - comma-separated as
   * title,middleInitial,alias,ssn,gender,occupation,dateOfBirth,maritalStatus,race,
   * ethnicity,language,religion,email. Each "blank" sub-value nulls the corresponding
   * field rather than leaving the template default. title is applied last (matching
   * Java) since fullNameWithTitle depends on the middleInitial resolved earlier in the
   * same pass.
   */
  private async applyPatientAdditionalDetails(
    body: Record<string, unknown>,
    raw: string,
    firstName: string,
    lastName: string
  ): Promise<Record<string, unknown>> {
    const parts = raw.split(',').map((p) => p.trim());
    if (parts.length < 13) {
      throw new Error(
        `applyPatientAdditionalDetails: expected 13 comma-separated fields (title,middleInitial,alias,ssn,gender,occupation,dateOfBirth,maritalStatus,race,ethnicity,language,religion,email) but got ${parts.length} in "${raw}"`
      );
    }
    const [title, middleInitialRaw, alias, ssn, gender, occupation, dateOfBirth, maritalStatus, race, ethnicity, language, religion, email] =
      parts;

    let middleInitial: string | null = null;
    if (!isBlank(middleInitialRaw)) {
      middleInitial = middleInitialRaw;
      body = updateField(updateField(body, 'fullName', `${firstName} ${middleInitial}. ${lastName}`), 'middleInitial', middleInitial);
    } else {
      body = updateField(body, 'middleInitial', null);
    }

    body = updateField(body, 'alias', isBlank(alias) ? null : alias);
    body = updateField(body, 'ssn', isBlank(ssn) ? null : ssn);
    body = updateField(body, 'gender', isBlank(gender) ? null : gender);
    body = updateField(body, 'occupation', isBlank(occupation) ? null : occupation);
    body = updateField(body, 'dateOfBirth', isBlank(dateOfBirth) ? null : dateOfBirth);

    if (!isBlank(maritalStatus)) {
      body = updateField(updateField(body, 'maritalStatus', maritalStatus), 'maritalStatusId', getMaritalStatusId(maritalStatus));
    } else {
      body = updateField(updateField(body, 'maritalStatus', null), 'maritalStatusId', null);
    }

    if (!isBlank(race)) {
      const found = await this.getDictionaryDetails('Race', race);
      const raceId = found ? this.responseCache.get<number>(Keys.KEY_DICTIONARY_ITEM_ID) : null;
      body = updateField(updateField(body, 'race', race), 'raceId', raceId);
    } else {
      body = updateField(updateField(body, 'race', null), 'raceId', null);
    }

    if (!isBlank(ethnicity)) {
      const ethnicityId = ethnicity.toLowerCase() === 'hispanic' ? 1 : ethnicity.toLowerCase() === 'non-hispanic' ? 2 : null;
      body = updateField(updateField(body, 'ethnicity', ethnicity), 'ethnicityId', ethnicityId);
    } else {
      body = updateField(updateField(body, 'ethnicity', null), 'ethnicityId', null);
    }

    if (!isBlank(language)) {
      body = updateField(updateField(body, 'patientLanguage', language), 'languageId', await this.getLanguageId(language));
    } else {
      body = updateField(updateField(body, 'patientLanguage', null), 'languageId', null);
    }

    if (!isBlank(religion)) {
      const found = await this.getDictionaryDetails('Religion', religion);
      const religionId = found ? this.responseCache.get<number>(Keys.KEY_DICTIONARY_ITEM_ID) : null;
      body = updateField(updateField(body, 'religion', religion), 'religionId', religionId);
    } else {
      body = updateField(updateField(body, 'religion', null), 'religionId', null);
    }

    body = updateField(body, 'email', isBlank(email) ? null : email);

    if (!isBlank(title)) {
      body = updateField(body, 'title', title);
      body = updateField(
        body,
        'fullNameWithTitle',
        middleInitial ? `${firstName} ${middleInitial} ${lastName}, ${title}` : `${firstName} ${lastName}, ${title}`
      );
    } else {
      body = updateField(body, 'fullNameWithTitle', middleInitial ? `${firstName} ${middleInitial} ${lastName}` : `${firstName} ${lastName}`);
    }

    return body;
  }

  /**
   * Port of WebServiceClient.createInsurance. Each ';'-separated index creates/reuses
   * one insurance carrier+plan+claim office, falling back to the last successfully-
   * indexed value for any per-index field that's missing (matching the Java original's
   * try/catch-and-keep-previous-value behavior). If saveInsuranceCarrier detects the
   * carrier+plan already exists AND that existing plan already has a claim office,
   * the claim-office/plan creation steps are skipped entirely (matches Java: only
   * proceeds when insuranceClaimOfficeid is still null after saveInsuranceCarrier).
   */
  async createInsurance(p: CreateInsuranceParams): Promise<void> {
    const insuranceNames = p.insuranceName.split(';');
    const planNames = p.planName.split(';');
    const insuranceClassifications = p.insuranceClassification.split(';');
    const officeNames = p.officeName.split(';');
    const line1s = p.line1.split(';');
    const cities = p.city.split(';');
    const contactNames = p.contactName.split(';');
    const phones = p.phone.split(';');
    const zips = p.zip.split(';');
    const extendedZips = p.extendedZip.split(';');
    const states = p.State.split(';');
    const electronicClaims = p.electronicClaim?.split(';') ?? [];
    const paperForms = p.paperForm?.split(';') ?? [];
    const contracts = p.contractName?.split(';') ?? [];
    const ePayerCodes = p.ePayerCode?.split(';') ?? [];

    let planName = planNames[0];
    let insuranceClassification = insuranceClassifications[0];
    let officeName = officeNames[0];
    let line1 = line1s[0];
    let city = cities[0];
    let contactName = contactNames[0];
    let phone = phones[0];
    let zip = zips[0];
    let extendedZip = extendedZips[0];
    let state = states[0];
    let electronicClaim = electronicClaims[0];
    let paperForm = paperForms[0];
    let contractName = contracts[0];
    let ePayerCode = ePayerCodes[0];

    for (let i = 0; i < insuranceNames.length; i++) {
      const insuranceName = insuranceNames[i];
      if (planNames[i] !== undefined) planName = planNames[i];
      if (electronicClaims[i] !== undefined) electronicClaim = electronicClaims[i];
      if (paperForms[i] !== undefined) paperForm = paperForms[i];
      if (insuranceClassifications[i] !== undefined) insuranceClassification = insuranceClassifications[i];
      if (officeNames[i] !== undefined) officeName = officeNames[i];
      if (line1s[i] !== undefined) line1 = line1s[i];
      if (cities[i] !== undefined) city = cities[i];
      if (contactNames[i] !== undefined) contactName = contactNames[i];
      if (phones[i] !== undefined) phone = phones[i];
      if (zips[i] !== undefined) zip = zips[i];
      if (extendedZips[i] !== undefined) extendedZip = extendedZips[i];
      if (states[i] !== undefined) state = states[i];
      if (contracts[i] !== undefined) contractName = contracts[i];
      if (ePayerCodes[i] !== undefined) ePayerCode = ePayerCodes[i];

      await this.createSession(p.facility);
      this.responseCache.put(Keys.KEY_INSURANCE_CARRIER_ID, null);
      this.responseCache.put(Keys.KEY_INSURANCE_PLAN_ID, null);
      this.responseCache.put(Keys.KEY_INSURANCE_CLAIM_OFFICE_ID, null);

      const response = await this.saveInsuranceCarrier(insuranceName, planName, insuranceClassification, electronicClaim, paperForm, ePayerCode);

      if (response === null || response.statusCode === 200) {
        if (this.responseCache.get(Keys.KEY_INSURANCE_CLAIM_OFFICE_ID) == null) {
          const insuranceCarrierId = String(this.responseCache.get(Keys.KEY_INSURANCE_CARRIER_ID));

          const claimOfficeResponse = await this.insertInsuranceClaimOffice(insuranceCarrierId, officeName, line1, city, contactName, phone, zip, extendedZip, state);
          let insurancePlanId = this.responseCache.has(Keys.KEY_INSURANCE_PLAN_ID) ? String(this.responseCache.get(Keys.KEY_INSURANCE_PLAN_ID) ?? '') : null;
          if (insurancePlanId === '' || insurancePlanId === 'null') insurancePlanId = null;

          if (claimOfficeResponse.statusCode === 200) {
            await this.saveInsurancePlan(insuranceCarrierId, insurancePlanId, planName, insuranceClassification, officeName, line1, city, contactName, phone, zip, extendedZip, state, p.generateTrue, contractName);
            await this.updateInsuranceClaimOffice(insuranceCarrierId, officeName, line1, city, contactName, phone, zip, extendedZip, state);

            insurancePlanId = this.responseCache.has(Keys.KEY_INSURANCE_PLAN_ID) ? String(this.responseCache.get(Keys.KEY_INSURANCE_PLAN_ID) ?? '') : null;
            if (insurancePlanId === '' || insurancePlanId === 'null') insurancePlanId = null;

            await this.saveInsurancePlan(insuranceCarrierId, insurancePlanId, planName, insuranceClassification, officeName, line1, city, contactName, phone, zip, extendedZip, state, p.generateTrue, contractName);
          }
        }
      }
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.createWorklist (the 11-param overload).
   * worklistType/worklistName/generalFlag/painFlag/giFlag/eyeFlag/laserFlag are
   * ';'-separated lists indexed in lockstep with worklistType (no fallback, matching
   * the Java original's unguarded splits); questions falls back to '' per-index
   * (matching the Java original's catch-and-reset-to-empty, not carry-over).
   */
  async createWorklist(
    facility: string,
    worklistType: string,
    worklistName: string,
    generalFlag: string,
    painFlag: string,
    giFlag: string,
    eyeFlag: string,
    laserFlag: string,
    questions: string | undefined
  ): Promise<void> {
    await this.createSession(facility);
    if (isBlank(worklistType)) return;

    const worklistTypes = worklistType.split(';');
    const worklistNames = worklistName.split(';');
    const generalFlags = generalFlag.split(';');
    const painFlags = painFlag.split(';');
    const giFlags = giFlag.split(';');
    const eyeFlags = eyeFlag.split(';');
    const laserFlags = laserFlag.split(';');
    const questionsList = questions?.split(';') ?? [];

    const worklistIds: string[] = [];

    for (let i = 0; i < worklistTypes.length; i++) {
      const ques = questionsList[i] ?? '';

      const worklistId = await this.addWorklistTemplate(
        worklistTypes[i],
        worklistNames[i],
        generalFlags[i].toLowerCase() === 'true',
        painFlags[i].toLowerCase() === 'true',
        giFlags[i].toLowerCase() === 'true',
        eyeFlags[i].toLowerCase() === 'true',
        laserFlags[i].toLowerCase() === 'true',
        ques
      );

      if (!isBlank(worklistId)) {
        worklistIds.push(worklistId);
      }
    }

    this.responseCache.put(Keys.KEY_WORKLIST_ID, worklistIds.join(';'));
  }

  /**
   * Port of ReUsableWebserviceUtils.createDischargeInstructions. configurationName/generalFlag/
   * painFlag/giFlag/eyeFlag/laserFlag are ';'-separated lists indexed in lockstep with
   * configurationName (no fallback, matching the Java original's unguarded splits). For each
   * index, reuses an existing discharge instruction configuration if one is already present
   * (by name), otherwise creates one.
   */
  async createDischargeInstructions(
    facility: string,
    configurationName: string,
    generalFlag: string,
    painFlag: string,
    giFlag: string,
    eyeFlag: string,
    laserFlag: string
  ): Promise<void> {
    await this.createSession(facility);

    const configurationNames = configurationName.split(';');
    const generalFlags = generalFlag.split(';');
    const painFlags = painFlag.split(';');
    const giFlags = giFlag.split(';');
    const eyeFlags = eyeFlag.split(';');
    const laserFlags = laserFlag.split(';');

    for (let i = 0; i < configurationNames.length; i++) {
      this.responseCache.put(Keys.KEY_DISCHARGE_INSTR_CONFIGURATION_ID, null);
      const alreadyPresent = await this.getDischargeInstrDetails(configurationNames[i]);
      if (!alreadyPresent) {
        await this.addDischargeInstructions(
          configurationNames[i],
          generalFlags[i].toLowerCase() === 'true',
          painFlags[i].toLowerCase() === 'true',
          giFlags[i].toLowerCase() === 'true',
          eyeFlags[i].toLowerCase() === 'true',
          laserFlags[i].toLowerCase() === 'true'
        );
      }
    }
  }

  /**
   * Port of WebServiceClient.createConsents. consentName/generalFlag/painFlag/giFlag/eyeFlag/
   * laserFlag/physicianScheduleFlag/procdeureScheduleFlag/diagnosisScheduleFlag/
   * consentStatementText/signeeDetails are ';'-separated lists indexed in lockstep with
   * consentName (no fallback, matching the Java original's unguarded splits). For each index,
   * reuses an existing consent configuration if one is already present (by name), otherwise
   * creates one.
   */
  async createConsents(
    facility: string,
    consentName: string,
    generalFlag: string,
    painFlag: string,
    giFlag: string,
    eyeFlag: string,
    laserFlag: string,
    physicianScheduleFlag: string,
    procdeureScheduleFlag: string,
    diagnosisScheduleFlag: string,
    consentStatementText: string | undefined,
    signeeDetails: string | undefined
  ): Promise<void> {
    await this.createSession(facility);

    const consentNames = consentName.split(';');
    const generalFlags = generalFlag.split(';');
    const painFlags = painFlag.split(';');
    const giFlags = giFlag.split(';');
    const eyeFlags = eyeFlag.split(';');
    const laserFlags = laserFlag.split(';');
    const physicianScheduleFlags = physicianScheduleFlag.split(';');
    const procdeureScheduleFlags = procdeureScheduleFlag.split(';');
    const diagnosisScheduleFlags = diagnosisScheduleFlag.split(';');
    const consentStatementTexts = consentStatementText?.split(';') ?? [];
    const signeeDetailsList = signeeDetails?.split(';') ?? [];

    for (let i = 0; i < consentNames.length; i++) {
      this.responseCache.put(Keys.KEY_CONSENTS_ID, null);
      const alreadyPresent = await this.getConsentDetails(consentNames[i]);
      if (!alreadyPresent) {
        await this.addConsent(
          consentNames[i],
          generalFlags[i].toLowerCase() === 'true',
          painFlags[i].toLowerCase() === 'true',
          giFlags[i].toLowerCase() === 'true',
          eyeFlags[i].toLowerCase() === 'true',
          laserFlags[i].toLowerCase() === 'true',
          physicianScheduleFlags[i].toLowerCase() === 'true',
          procdeureScheduleFlags[i].toLowerCase() === 'true',
          diagnosisScheduleFlags[i].toLowerCase() === 'true',
          consentStatementTexts[i],
          signeeDetailsList[i]
        );
      }
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.insertFeeSchedule (the 6-param orchestrator
   * overload). cptCode/amount/billableStatus are '|'-separated lists; skips any
   * CPT code that already has a fee schedule record, matching the Java original's
   * duplicate check. billableStatus falls back to "Billable" (the Java default)
   * when its index is missing or blank.
   */
  async insertFeeSchedule(
    username: string,
    password: string,
    facility: string,
    cptCode: string,
    amount: string,
    billableStatus: string
  ): Promise<void> {
    await this.createSession(facility, username, password);
    const existingSchedules = await this.getAllFeeSchedules();

    if (isBlank(cptCode)) return;

    const cptCodes = cptCode.split('|');
    const amounts = amount.split('|');
    const billableStatuses = billableStatus.split('|');
    let bilableState = 'Billable';

    for (let i = 0; i < cptCodes.length; i++) {
      const code = cptCodes[i];
      const exists = existingSchedules.some((fs) => {
        const cptProcedure = fs.cptProcedure as Record<string, unknown> | undefined;
        return cptProcedure?.cptCode === code;
      });

      if (exists) continue;

      if (billableStatuses[i] && billableStatuses[i] !== '') {
        bilableState = billableStatuses[i];
      }
      await this.insertFeeScheduleRecord(code, Math.round(Number(amounts[i])), bilableState);
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.createPeriodBatch. batchName is a
   * ';'-separated list - each entry is created against the same period.
   */
  async createPeriodBatch(
    userID: string,
    password: string,
    facility: string,
    periodName: string,
    periodBeginDate: string,
    periodEndDate: string,
    isActive: boolean,
    batchName: string
  ): Promise<void> {
    if (isBlank(periodName)) return;

    await this.createSession(facility, userID, password);
    const periodId = await this.createPeriod(userID, periodName, periodBeginDate, periodEndDate, isActive);

    if (!isBlank(batchName) && periodId) {
      for (const name of batchName.split(';')) {
        await this.createBatch(userID, periodId, name);
      }
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.createNewTransactionCodes. transactionCodeName is
   * a ';'-separated list; transactiontype pairs up by index and, matching the Java
   * original's try/catch-and-keep-previous-value behavior, falls back to the last
   * successfully-indexed type when an index is missing. Failures are caught and
   * logged rather than thrown - the Java original explicitly suppresses the throw
   * here ("suppressing the throw exception until the duplicate check has implemented").
   */
  async createNewTransactionCodes(
    userID: string,
    password: string,
    facility: string,
    transactionCodeName: string,
    transactiontype: string
  ): Promise<void> {
    try {
      if (isBlank(transactionCodeName)) return;

      const names = transactionCodeName.split(';');
      const types = transactiontype.split(';');
      let type = types[0];

      for (let i = 0; i < names.length; i++) {
        if (types[i] !== undefined) type = types[i];
        await this.createSession(facility, userID, password);
        await this.createNewTransactionCode(names[i], type);
      }
    } catch (err) {
      console.error('[WebServiceClient] createNewTransactionCodes failed (suppressed, matching Java original):', err);
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.buildCaseSummaryObj (core scheduling fields
   * only - patient, dates, room, appointment type, physician). Throws if
   * preferenceCardName is set since addPreferenceCardToPatient isn't ported yet
   * (same pattern as createJustAPatient's unported detail sub-builders).
   */
  private async buildCaseSummaryObj(
    caseSummaryRequestObj: Record<string, unknown>,
    p: CreateCaseSummaryParams
  ): Promise<Record<string, unknown>> {
    const patientRaw = this.responseCache.get<string>(Keys.KEY_CREATE_PATIENT_RESPONSE);
    if (!patientRaw) {
      throw new Error('buildCaseSummaryObj: no cached patient response - createJustAPatient must run before createCaseSummary');
    }
    const patient = JSON.parse(patientRaw);

    await this.getAppointmentType(p.appointmentType);

    this.responseCache.put(Keys.KEY_PATIENT_ID, patient.patientId);
    this.responseCache.put(Keys.KEY_PATIENT_FIRST_NAME, patient.firstName);
    this.responseCache.put(Keys.KEY_PATIENT_LAST_NAME, patient.lastName);

    const address = getPath(caseSummaryRequestObj, 'patient.address');
    setPath(caseSummaryRequestObj, 'patient', patient);
    setPath(caseSummaryRequestObj, 'dateOfService', addDate(p.dos, 'MM/dd/yyyy'));

    const dos = addDate(p.dos, 'yyyy-MM-dd');
    setPath(caseSummaryRequestObj, 'patient.address', address);

    const procedureStart = `${dos}T${p.startTime}:00-0500`;
    const procedureStop = `${dos}T${p.endTime}:00-0500`;

    setPath(caseSummaryRequestObj, 'procedureDt', procedureStart);
    setPath(caseSummaryRequestObj, 'patientId', patient.patientId);
    setPath(caseSummaryRequestObj, 'startTime', p.startTime);
    setPath(caseSummaryRequestObj, 'endTime', p.endTime);
    setPath(caseSummaryRequestObj, 'procedureStartDt', procedureStart);
    setPath(caseSummaryRequestObj, 'procedureStopDt', procedureStop);
    setPath(caseSummaryRequestObj, 'procedureStartTime', procedureStart);
    setPath(caseSummaryRequestObj, 'procedureStopTime', procedureStop);

    setPath(caseSummaryRequestObj, 'roomId', Number(await this.getRoomIdForRoomName(p.roomName)));
    setPath(caseSummaryRequestObj, 'roomName', p.roomName);

    setPath(caseSummaryRequestObj, 'appointmentTypeId', this.getAppointmentTypeId());
    setPath(caseSummaryRequestObj, 'caseType', this.getAppointmentTypeCaseType());

    const [physicianFullName, , physicianId] = await this.getPhysicianNameIDFromPhysicianName(p.physicianUser.split(';')[0]);
    setPath(caseSummaryRequestObj, 'primaryPhysicianId', Number(physicianId));
    setPath(caseSummaryRequestObj, 'referringPhysicianId', Number(physicianId));
    setPath(caseSummaryRequestObj, 'referringPhysicianName', physicianFullName);

    if (!isBlank(p.preferenceCardName)) {
      caseSummaryRequestObj = await this.addPreferenceCardToPatient(caseSummaryRequestObj, p.preferenceCardName!);
    }

    return caseSummaryRequestObj;
  }

  /**
   * Port of ReUsableWebserviceUtils.addPreferenceCardToPatient. Throws if the
   * preference card isn't found for the facility, matching the Java original's
   * RuntimeException rather than silently skipping it.
   */
  private async addPreferenceCardToPatient(
    caseSummaryRequestObj: Record<string, unknown>,
    preferenceCardName: string
  ): Promise<Record<string, unknown>> {
    const isPresent = await this.isPreferenceCardPresent(preferenceCardName);
    if (!isPresent) {
      throw new Error(`${preferenceCardName} Preference card is not present`);
    }

    const preferenceCardId = String(this.responseCache.get(Keys.KEY_PREFERENCE_CARD_ID));
    const equipmentDetails = await this.getEquipmentDetailsForPreferenceCard(preferenceCardId);
    if (equipmentDetails) {
      const caseEquipments = equipmentDetails.map((equipment) => ({
        ...equipment,
        isShowRedFont: false,
        inUse: 1,
        equipmentQtyUsed: 1,
      }));
      setPath(caseSummaryRequestObj, 'caseEquipments', caseEquipments);
    }

    setPath(caseSummaryRequestObj, 'casePreferenceCards', [
      {
        caseSummaryId: 0,
        preferenceCardId: Number(preferenceCardId),
        preferenceCardName,
        sortOrder: 0,
      },
    ]);

    return caseSummaryRequestObj;
  }

  /**
   * Port of ReUsableWebserviceUtils.updateCaseSumryObjWithMultipleCPTCodes. cptCode is
   * '|'-separated (one entry per procedure); lterality/physicianUser are ';'-separated
   * and - matching the Java original's try/catch-and-keep-previous-value behavior -
   * fall back to the last successfully-indexed value when an index is missing rather
   * than resetting to blank. preOpDiagnosisCode is ';'-separated per procedure and
   * ','-separated within a procedure (multiple ICD codes), with no carry-over.
   */
  private async updateCaseSumryObjWithMultipleCPTCodes(
    caseSummaryRequestObj: Record<string, unknown>,
    p: CreateCaseSummaryParams
  ): Promise<Record<string, unknown>> {
    const cptCodes = p.cptCode.split('|');
    const lateralities = p.lterality?.split(';') ?? [];
    const physicianUsers = p.physicianUser.split(';');
    const preOpDiagnosisCodes = p.preOpDiagnosisCode?.split(';') ?? [];
    const procedureTemplate = getPath(caseSummaryRequestObj, 'caseProcedures[0]') as Record<string, unknown>;

    const procedures: Record<string, unknown>[] = [];
    let lterality = p.lterality ?? '';
    let physicianUser = physicianUsers[0];

    for (let i = 0; i < cptCodes.length; i++) {
      const cptCode = cptCodes[i];
      if (lateralities[i] !== undefined) lterality = lateralities[i];
      if (physicianUsers[i] !== undefined) physicianUser = physicianUsers[i];
      const diagCodePreOp = preOpDiagnosisCodes[i] ?? '';

      const feeSchedule = await this.getFeeScheduleByCptCode(cptCode);
      const cptProcedure = feeSchedule?.cptProcedure as Record<string, unknown> | undefined;
      const cptDescription = cptProcedure?.cptDescription;
      const displayName = `${cptProcedure?.cptCode}; ${cptDescription}`;

      const [physicianFullName, , physicianId] = await this.getPhysicianNameIDFromPhysicianName(physicianUser);
      const [laterality, lateralityText] = getLaterality(lterality);

      const procedure: Record<string, unknown> = JSON.parse(JSON.stringify(procedureTemplate));
      procedure.cptCode = cptCode;
      procedure.feeScheduleItem = feeSchedule ?? null;
      procedure.procedureDescription = cptDescription;
      procedure.procedureDisplayName = displayName;
      procedure.selfPayTf = false;
      procedure.modifiedProcedureDescription = cptDescription;
      procedure.feeScheduleId = feeSchedule?.feeScheduleId;
      procedure.lateralityText = lateralityText;
      procedure.laterality = laterality;
      procedure.physicianId = physicianId;
      procedure.physician = physicianFullName;

      if (diagCodePreOp !== '') {
        const diagnosisList = [];
        for (const icdCode of diagCodePreOp.split(',')) {
          const icdCodeDesc = await this.returnIcdDescFromICDCode(icdCode);
          diagnosisList.push({
            diagnosisId: 0,
            procedureId: null,
            diagnosis: icdCodeDesc,
            icdCode,
            dictionaryItem: null,
            masterDiagnosisId: 0,
          });
        }
        procedure.diagnosisList = diagnosisList;
      }

      procedures.push(procedure);
    }

    setPath(caseSummaryRequestObj, 'caseProcedures', procedures);
    return caseSummaryRequestObj;
  }

  /**
   * Port of ReUsableWebserviceUtils.updateCaseSumryObjWithCaseFlags. caseFlagName
   * is a '|'-separated list of case flag names, each resolved via getCaseFlagDetails.
   */
  private async updateCaseSumryObjWithCaseFlags(
    caseSummaryRequestObj: Record<string, unknown>,
    caseFlagName: string
  ): Promise<Record<string, unknown>> {
    const caseFlagsArray: Record<string, unknown>[] = [];
    for (const name of caseFlagName.split('|')) {
      const caseFlag = await this.getCaseFlagDetails(name);
      caseFlagsArray.push({
        manuallyAdded: false,
        caseFlagId: caseFlag.caseFlagId,
        caseSummaryId: 0,
        caseFlagConfig: { ...caseFlag, manuallyAdded: false },
      });
    }
    setPath(caseSummaryRequestObj, 'caseSummaryCaseFlagMapList', caseFlagsArray);
    return caseSummaryRequestObj;
  }

  /**
   * Port of ReUsableWebserviceUtils.updatedCaseSummaryPayloadWithinsurance. Carriername
   * (and the paired subscriber fields) is a ';'-separated list - each entry inserts
   * one insurance to the patient, then the patient's resulting insurances are read
   * back and mapped into caseInsurances[0..2] by sort order (primary/secondary/tertiary).
   */
  private async updatedCaseSummaryPayloadWithinsurance(
    caseSummaryRequestObj: Record<string, unknown>,
    p: CreateCaseSummaryParams
  ): Promise<Record<string, unknown>> {
    const carrierNames = p.Carriername!.split(';');
    const relationships = p.RelationshiptoSubscriber?.split(';') ?? [];
    const firstNames = p.InsurancefirstName?.split(';') ?? [];
    const lastNames = p.InsurancelastName?.split(';') ?? [];
    const genders = p.gender?.split(';') ?? [];
    const subscriberIds = p.Subscriberid?.split(';') ?? [];
    const additionalDetailsList = p.insuranceAdditionalDetails?.split(';') ?? [];

    for (let i = 0; i < carrierNames.length; i++) {
      let firstName = firstNames[i] ?? '';
      if (firstName.toLowerCase() === 'blank') firstName = '';
      let lastName = lastNames[i] ?? '';
      if (lastName.toLowerCase() === 'blank') lastName = '';
      let gender = genders[i] ?? '';
      if (gender.toLowerCase() === 'blank') gender = '';

      await this.insertInsurancetoPatient(
        relationships[i] ?? '',
        firstName,
        lastName,
        gender,
        subscriberIds[i] ?? '',
        carrierNames[i],
        additionalDetailsList[i]
      );
    }

    const insurancesResponse = await this.getPatientInsurancesByPatientId();
    const insurances = Array.isArray(insurancesResponse.data) ? insurancesResponse.data : JSON.parse(insurancesResponse.raw);
    const insuranceKeys = [Keys.KEY_PRIMARY_INSURANCE_ID, Keys.KEY_SECONDARY_INSURANCE_ID, Keys.KEY_TERTIARY_INSURANCE_ID];

    const caseInsurances = getPath(caseSummaryRequestObj, 'caseInsurances') as Record<string, unknown>[];
    for (let i = 0; i < (insurances as Record<string, unknown>[]).length; i++) {
      const patientInsurance = (insurances as Record<string, unknown>[])[i];
      if (i < insuranceKeys.length) {
        this.responseCache.put(insuranceKeys[i], patientInsurance.patientInsuranceId);
      }
      // the template only ships 3 caseInsurances slots - grow it if this patient has more
      if (!caseInsurances[i]) caseInsurances[i] = {};
      setPath(caseSummaryRequestObj, `caseInsurances[${i}].patientInsurance`, patientInsurance);
      setPath(caseSummaryRequestObj, `caseInsurances[${i}].sortOrder`, i);
      setPath(caseSummaryRequestObj, `caseInsurances[${i}].caseSummaryId`, 0);
    }

    return caseSummaryRequestObj;
  }

  /**
   * Port of ReUsableWebserviceUtils.updatedCaseSummaryPayloadWithGuarantor. guarantorFirstName
   * (and paired fields) is a ';'-separated list - each entry is added to the patient via
   * addMultipleGuarantorToPatient, then primaryGuarantor/secondaryGuarantor ("self" or an
   * index into the added guarantors) select which one maps into caseGuarantor[0]/[1].
   */
  private async updatedCaseSummaryPayloadWithGuarantor(
    caseSummaryRequestObj: Record<string, unknown>,
    p: CreateCaseSummaryParams
  ): Promise<Record<string, unknown>> {
    const firstNames = p.guarantorFirstName!.split(';');
    const lastNames = p.guarantorLastName?.split(';') ?? [];
    const datesOfBirth = p.guarantorDateOfBirth?.split(';') ?? [];
    const countries = p.guarantorCountry?.split(';') ?? [];
    const isActiveList = p.guarantorIsActive?.split(';') ?? [];

    for (let i = 0; i < firstNames.length; i++) {
      await this.addMultipleGuarantorToPatient(
        String(this.responseCache.get(Keys.KEY_PATIENT_ID)),
        firstNames[i],
        lastNames[i] ?? '',
        datesOfBirth[i] ?? '',
        countries[i] ?? '',
        (isActiveList[i] ?? '').toLowerCase() === 'true'
      );
    }

    const patientId = Number(this.responseCache.get(Keys.KEY_PATIENT_ID));
    const guarantorTemplate = getPath(caseSummaryRequestObj, 'caseGuarantor[0]') as Record<string, unknown>;

    if (!isBlank(p.primaryGuarantor)) {
      let guarantorObj: Record<string, unknown> = JSON.parse(JSON.stringify(guarantorTemplate));
      setPath(guarantorObj, 'patientGuarantor.patientId', patientId);
      if (p.primaryGuarantor!.toLowerCase() === 'self') {
        setPath(guarantorObj, 'patientGuarantor.firstName', this.responseCache.get(Keys.KEY_PATIENT_FIRST_NAME));
        setPath(guarantorObj, 'patientGuarantor.lastName', this.responseCache.get(Keys.KEY_PATIENT_LAST_NAME));
      } else {
        const guarantorFirstNames = String(this.responseCache.get(Keys.KEY_GUARANTOR_FIRST_NAME)).split(';');
        const guarantorLastNames = String(this.responseCache.get(Keys.KEY_GUARANTOR_LAST_NAME)).split(';');
        const guarantorIds = String(this.responseCache.get(Keys.KEY_PATIENT_GUARANTOR_ID)).split(';');
        setPath(guarantorObj, 'patientGuarantor.firstName', guarantorFirstNames[0]);
        setPath(guarantorObj, 'patientGuarantor.lastName', guarantorLastNames[0]);
        setPath(guarantorObj, 'patientGuarantor.patientGuarantorId', Number(guarantorIds[0]));
        setPath(guarantorObj, 'guarantorId', Number(guarantorIds[0]));
        setPath(guarantorObj, 'isSelf', false);
      }
      setPath(caseSummaryRequestObj, 'caseGuarantor[0]', guarantorObj);
    }

    if (!isBlank(p.secondaryGuarantor)) {
      let tempObj: Record<string, unknown> = JSON.parse(JSON.stringify(guarantorTemplate));
      setPath(tempObj, 'patientGuarantor.patientId', patientId);
      setPath(tempObj, 'sortOrder', 2);
      if (p.secondaryGuarantor!.toLowerCase() === 'self') {
        setPath(tempObj, 'patientGuarantor.firstName', this.responseCache.get(Keys.KEY_PATIENT_FIRST_NAME));
        setPath(tempObj, 'patientGuarantor.lastName', this.responseCache.get(Keys.KEY_PATIENT_LAST_NAME));
      } else {
        const guarantorFirstNames = String(this.responseCache.get(Keys.KEY_GUARANTOR_FIRST_NAME)).split(';');
        const guarantorLastNames = String(this.responseCache.get(Keys.KEY_GUARANTOR_LAST_NAME)).split(';');
        const guarantorIds = String(this.responseCache.get(Keys.KEY_PATIENT_GUARANTOR_ID)).split(';');
        const lastIdx = firstNames.length - 1;
        setPath(tempObj, 'patientGuarantor.firstName', guarantorFirstNames[lastIdx]);
        setPath(tempObj, 'patientGuarantor.lastName', guarantorLastNames[lastIdx]);
        setPath(tempObj, 'patientGuarantor.patientGuarantorId', Number(guarantorIds[lastIdx]));
        setPath(tempObj, 'guarantorId', Number(guarantorIds[lastIdx]));
        setPath(tempObj, 'isSelf', false);
      }
      setPath(caseSummaryRequestObj, 'caseGuarantor[1]', tempObj);
    }

    return caseSummaryRequestObj;
  }

  /**
   * Port of ReUsableWebserviceUtils.createCaseSummary (/CaseSummaryComplex/Gemini/UpsertCaseSummary).
   * This is the step that actually books the patient's case/appointment - it
   * must run after createJustAPatient for the patient to show up on the
   * schedule grid. Throws on guarantor/insurance fields since those
   * sub-builders (updatedCaseSummaryPayloadWithGuarantor, updatedCaseSummaryPayloadWithinsurance)
   * aren't ported yet.
   */
  async createCaseSummary(p: CreateCaseSummaryParams): Promise<void> {
    const relURL = '/CaseSummaryComplex/Gemini/UpsertCaseSummary';
    let body = this.templates.load<Record<string, unknown>>('UpsertCaseSummary.json');

    body = await this.buildCaseSummaryObj(body, p);

    if (!isBlank(p.Carriername)) {
      body = await this.updatedCaseSummaryPayloadWithinsurance(body, p);
    }
    if (!isBlank(p.guarantorFirstName)) {
      body = await this.updatedCaseSummaryPayloadWithGuarantor(body, p);
    }

    body = await this.updateCaseSumryObjWithMultipleCPTCodes(body, p);

    if (!isBlank(p.caseFlags)) {
      body = await this.updateCaseSumryObjWithCaseFlags(body, p.caseFlags!);
    }

    if (!isBlank(p.anesthesiaType)) {
      const found = await this.getDictionaryDetails('Anesthesia Type', p.anesthesiaType!);
      if (found) {
        setPath(body, 'anesthesiaTypeId', this.responseCache.get<number>(Keys.KEY_DICTIONARY_ITEM_ID));
        setPath(body, 'anesthesiaTypeName', p.anesthesiaType);
      } else {
        console.warn(`[WebServiceClient] Anesthesia type not found, skipping mapping: ${p.anesthesiaType}`);
      }
    }

    const response = await this.runWebServiceRequestWithRetryOnTransientFailure(body, relURL, 'POST');
    const parsed = JSON.parse(response.raw);
    this.responseCache.put(Keys.KEY_CASE_SUMMARY_ID, String(parsed.caseSummaryId));
    this.responseCache.put(Keys.KEY_CASE_APPOINTMENT_ID, String(parsed.appointmentId));
    this.responseCache.put(Keys.KEY_CASE_SUMMARY_RESPONSE, response.raw);
    this.responseCache.put(Keys.KEY_CASE_START_TIME, String(parsed.procedureStartDt));

    if (!isBlank(p.guarantorAdditionalDetails)) {
      await this.updateCaseSummaryWithGuarantorAdditionalInformation(p.guarantorAdditionalDetails!);
    }
  }

  /**
   * Port of the patientOperations lock -> payerEligibilityReq -> release-lock
   * sequence (ReUsableWebserviceUtils.java reqlockCasePatient/payerEligibilityReq/
   * relreaseLockPatient). RecordLockTypeId 15 matches the Java original.
   */
  private async checkPatientInsuranceEligibility(): Promise<void> {
    await this.requestLock(15);
    await this.sendPayerEligibility();
    await this.releaseLock(15);
  }

  /**
   * Port of ReUsableWebserviceUtils.signPatientDepartments/signPatientDepartment.
   * departments is a ';'-separated list of department/module names, each
   * signed independently via BasicModuleInfoSignature/SignByCurrentUser.
   */
  async signPatientDepartments(departments: string): Promise<void> {
    for (const departmentName of departments.split(';')) {
      await this.getCaseDetailInformation(departmentName);
      const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID);
      const moduleId = this.responseCache.getString(Keys.KEY_MODULE_ID);
      await this.runWebServiceRequest('', `BasicModuleInfoSignature/SignByCurrentUser/${caseSummaryId}/${moduleId}`, 'POST');
    }
  }

  /**
   * Port of the patientOperations arrival sequence (updatePatientArrivalTime ->
   * updateCaseStatus("2") -> UpsertCaseSummaryInfoForArrival). arrivalTime is a
   * "date,time"-formatted string, matching the Java original.
   */
  async checkInPatientArrival(arrivalTime: string): Promise<void> {
    const [date, time] = arrivalTime.split(',');
    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID)!;
    const appointmentId = this.responseCache.getString(Keys.KEY_CASE_APPOINTMENT_ID)!;
    await this.updatePatientArrivalTime(date, time, appointmentId);
    await this.updateCaseStatus(caseSummaryId, '2');
    await this.upsertCaseSummaryInfo('2', null, '1');
  }

  /**
   * Port of ReUsableWebserviceUtils.addOPNotesToPatient. opNotes is a
   * ';'-separated list of op-note names, each created from its config
   * template and then updated with the (base64-encoded) note text/variables.
   */
  async addOPNotesToPatient(opNotes: string): Promise<void> {
    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID)!;

    for (const opNote of opNotes.split(';')) {
      const found = await this.getPhysicianOpNotesDetails(opNote);
      if (!found) {
        throw new Error(`addOPNotesToPatient: no op note found with name "${opNote}"`);
      }
      const opNoteConfigId = this.responseCache.getString(Keys.KEY_PHYSICIAN_OP_NOTES_ID)!;

      const createResponse = await this.runWebServiceRequest(caseSummaryId, `/OpNoteDocumentation/CreateFromTemplate/${opNoteConfigId}`, 'POST');
      const opNoteId = createResponse.raw;

      const physicianOpNotes = await this.getPhysicianOpNotesById(opNoteId);
      const textObject = physicianOpNotes.textObject as Record<string, unknown>;
      const variableObject = physicianOpNotes.variableObject as Record<string, unknown>;

      let body = this.templates.load<Record<string, unknown>>('opNotesUpdateRequest.json');
      body = updateField(body, 'opNoteId', opNoteId);
      body = updateField(body, 'caseSummaryId', Number(caseSummaryId));
      body = updateField(body, 'opNoteName', physicianOpNotes.opNoteName);
      body = updateField(body, 'percentageCompleted', 100);
      setPath(body, 'textObject.opNoteId', opNoteId);
      setPath(body, 'textObject.noteText', encodeString2Base64(String(textObject.noteText)));
      setPath(body, 'variableObject.opNoteId', opNoteId);
      const serializedVariables = variableObject.serializedVariables;
      const serializedVariablesText = typeof serializedVariables === 'string' ? serializedVariables : JSON.stringify(serializedVariables);
      setPath(body, 'variableObject.serializedVariables', encodeString2Base64(serializedVariablesText));

      await this.runWebServiceRequest(body, '/OpNoteDocumentation/', 'PUT');
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.performPatientCasesToCode. Builds one
   * performedItems[] entry per scheduled procedure (all sharing the same
   * diagnosisCode match), submits it, then transitions the case to status 11.
   */
  async performPatientCasesToCode(diagnosisCode: string): Promise<Record<string, unknown>> {
    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID)!;
    const template = this.templates.load<Record<string, unknown>>('CasesToCodeRequest.json');
    const performedItemTemplate = getPath(template, 'performedItems[0]') as Record<string, unknown>;

    const scheduledProcedures = await this.getScheduledProcedures(caseSummaryId);
    const diagnosisCodes = await this.getICDCodeClassifications(diagnosisCode);
    const diagnosisCodeObject = findByField(diagnosisCodes, 'icdCode', diagnosisCode);
    if (!diagnosisCodeObject) {
      throw new Error(`performPatientCasesToCode: no ICD code classification found for "${diagnosisCode}"`);
    }

    const performedItems = scheduledProcedures.map((procedure, index) => {
      const item: Record<string, unknown> = JSON.parse(JSON.stringify(performedItemTemplate));
      item.units = 1.0;
      item.caseSummaryId = Number(procedure.caseSummaryId);
      item.providerId = Number(procedure.physicianId);
      item.cptProcedureId = Number(procedure.cptProcedureId);
      item.feeScheduleItem = procedure.feeScheduleItem;
      item.sortorder = index;
      item.feeScheduleId = Number(procedure.feeScheduleId);
      item.caseProcedureId = Number(procedure.caseProcedureId);
      item.cptCode = procedure.cptCode;
      item.cptProcedureDescription = procedure.cptDescription;
      item.physicianName = procedure.physicianName;
      setPath(item, 'diagnosisList[0].dictionaryItem.id', Number(diagnosisCodeObject.icdCodeId));
      setPath(item, 'diagnosisList[0].dictionaryItem.quickCode', diagnosisCodeObject.icdCode);
      setPath(item, 'diagnosisList[0].dictionaryItem.value', diagnosisCodeObject.icdCodeDescription);
      setPath(item, 'diagnosisList[0].diagnosisId', Number(diagnosisCodeObject.icdCodeId));
      return item;
    });

    const casesToCodeResponse = await this.performCasesToCode({ performedItems, deletedPerformedItems: [] });
    this.responseCache.put(Keys.KEY_CASES_TO_CODE_RESPONSE, casesToCodeResponse);

    await this.updateCaseStatus(caseSummaryId, '11');
    await this.upsertCaseSummaryInfo('11', '10', '10');

    return casesToCodeResponse;
  }

  /**
   * Port of ReUsableWebserviceUtils.performPatientChargeEntry. Builds one
   * charge-entry request per performed-procedure entry from the cases-to-code
   * response (Phase 6 must run first), maps in primary/secondary/tertiary
   * insurance if present, then transitions the case to status 12.
   */
  async performPatientChargeEntry(periodName: string, batchName: string, amount: string): Promise<void> {
    const casesToCodeResponse = this.responseCache.get<Record<string, unknown>>(Keys.KEY_CASES_TO_CODE_RESPONSE);
    if (!casesToCodeResponse) {
      throw new Error('performPatientChargeEntry: no cached cases-to-code response - performPatientCasesToCode must run first');
    }

    const period = await this.getPeriodByName(periodName);
    const batch = await this.getBatchForChargeEntry(periodName, batchName);
    if (!period || !batch) {
      throw new Error(`performPatientChargeEntry: no period/batch found for periodName="${periodName}" batchName="${batchName}"`);
    }

    const allAmounts = amount.includes(';') ? amount.split(';') : [amount];
    const result = casesToCodeResponse.result as Record<string, unknown>;
    const performedProcedures = (result.performedItems as Record<string, unknown>[] | null) ?? [];
    if (performedProcedures.length === 0) {
      throw new Error('performPatientChargeEntry: no performed items found in cases-to-code response');
    }

    const chargeEntryRequestBody: Record<string, unknown>[] = [];
    let caseSummaryId = '';

    for (let i = 0; i < performedProcedures.length; i++) {
      const performedProcedure = performedProcedures[i];
      const chargeEntryTemplate = this.templates.load<Record<string, unknown>[]>('chargeEntryRequest.json');
      const chargeEntryObject = chargeEntryTemplate[0];
      const chargeDetails = getPath(chargeEntryObject, 'transactionList[0].chargeDetails') as Record<string, unknown>;
      const chargeTransactionChargeDetails = getPath(chargeEntryObject, 'chargeTransaction.chargeDetails') as Record<string, unknown>;

      chargeEntryObject.cptProcedureId = performedProcedure.cptProcedureId;
      chargeEntryObject.patientId = performedProcedure.patientId;
      chargeEntryObject.caseProcedureId = performedProcedure.caseProcedureId;
      chargeEntryObject.cptCode = performedProcedure.cptCode;
      chargeEntryObject.physicianName = performedProcedure.physicianName;
      chargeEntryObject.performedCaseProcedureId = performedProcedure.performedCaseProcedureId;
      chargeDetails.performedCaseProcedureId = performedProcedure.performedCaseProcedureId;
      chargeDetails.balance = Math.round(Number(allAmounts[i]));
      chargeDetails.transactionId = 0;
      chargeEntryObject.units = 1;
      chargeEntryObject.sortorder = i;
      caseSummaryId = String(performedProcedure.caseSummaryId);
      chargeEntryObject.feeScheduleItem = performedProcedure.feeScheduleItem;
      chargeEntryObject.cptProcedureDescription = performedProcedure.cptProcedureDescription;
      chargeEntryObject.caseSummaryId = performedProcedure.caseSummaryId;
      chargeEntryObject.providerId = performedProcedure.providerId;
      chargeEntryObject.feeScheduleId = performedProcedure.feeScheduleId;
      chargeEntryObject.diagnosisList = performedProcedure.diagnosisList;
      chargeEntryObject.batch = batch;

      const transactionObject: Record<string, unknown> = {
        period,
        batch,
        transactionId: 0,
        periodId: period.periodId,
        batchId: batch.batchId,
        amount: allAmounts[i],
        batchDescription: batch.batchDescription,
        chargeDetails,
      };
      chargeEntryObject.transactionList = [transactionObject];

      chargeTransactionChargeDetails.peformedCaseProcedureId = performedProcedure.performedCaseProcedureId;
      chargeTransactionChargeDetails.balance = Math.round(Number(allAmounts[i]));
      chargeTransactionChargeDetails.transactionId = 0;
      const chargeTransactionObject: Record<string, unknown> = {
        periodId: period.periodId,
        batchId: batch.batchId,
        batchDescription: batch.batchDescription,
        amount: Number(allAmounts[i]),
        period,
        batch,
        chargeDetails: chargeTransactionChargeDetails,
      };
      chargeEntryObject.chargeTransaction = chargeTransactionObject;

      const primaryInsuranceId = this.responseCache.get<number>(Keys.KEY_PRIMARY_INSURANCE_ID);
      if (primaryInsuranceId != null) {
        chargeEntryObject.primaryInsuranceId = primaryInsuranceId;
        chargeEntryObject.chargeEntryPatientInsMap = [
          { patientInsuranceId: primaryInsuranceId, chargeEntryDetailsId: 0, insuranceUsedInTransfer: false, sortOrder: 0, canBillGenerated: true },
        ];
        chargeEntryObject.primaryInsurancesList = [{ patientInsuranceId: primaryInsuranceId, displayName: null }];
      }
      const secondaryInsuranceId = this.responseCache.get<number>(Keys.KEY_SECONDARY_INSURANCE_ID);
      if (secondaryInsuranceId != null) {
        chargeEntryObject.secondaryInsuranceId = secondaryInsuranceId;
        chargeEntryObject.chargeEntryPatientInsMap = [
          ...((chargeEntryObject.chargeEntryPatientInsMap as unknown[]) ?? []),
          { patientInsuranceId: secondaryInsuranceId, chargeEntryDetailsId: 0, insuranceUsedInTransfer: false, sortOrder: 1, canBillGenerated: true },
        ];
        chargeEntryObject.secondaryInsurancesList = [{ patientInsuranceId: secondaryInsuranceId, displayName: null }];
      }
      const tertiaryInsuranceId = this.responseCache.get<number>(Keys.KEY_TERTIARY_INSURANCE_ID);
      if (tertiaryInsuranceId != null) {
        chargeEntryObject.tertiaryInsuranceId = tertiaryInsuranceId;
        chargeEntryObject.chargeEntryPatientInsMap = [
          ...((chargeEntryObject.chargeEntryPatientInsMap as unknown[]) ?? []),
          { patientInsuranceId: tertiaryInsuranceId, chargeEntryDetailsId: 0, insuranceUsedInTransfer: false, sortOrder: 2, canBillGenerated: true },
        ];
        chargeEntryObject.tertiaryInsurancesList = [{ patientInsuranceId: tertiaryInsuranceId, displayName: null }];
      }

      chargeEntryRequestBody.push(chargeEntryObject);
    }

    const chargeEntryResponse = await this.performChargeEntry(chargeEntryRequestBody);
    this.responseCache.put(Keys.KEY_CHARGE_ENTRY_RESPONSE, chargeEntryResponse);

    // Java's performPatientChargeEntry calls updateCaseStatus(caseSummaryId, "12") twice
    // (once here, once again below) - preserved as-is for parity, likely a harmless duplicate.
    await this.updateCaseStatus(caseSummaryId, '12');
    const chargeDetailsResp = getPath(chargeEntryResponse, 'result[0].transactionList[0].chargeDetails');
    this.responseCache.put(Keys.KEY_CHARGE_DETAILS_RESP, chargeDetailsResp);

    await this.updateCaseStatus(caseSummaryId, '12');
    await this.upsertCaseSummaryInfo('12', '10', '11');
  }

  /**
   * Port of ReUsableWebserviceUtils.dischargePatient. dischargeDetails is
   * ";"-separated as "departmentName;userID;dischargedTo" - dischargedTo is
   * optional; if the string has no ";" at all, it's treated as a bare userID
   * with departmentName defaulting to "Recovery" (matching the Java original).
   * Java calls getPatientHandsOffData() twice in a row before the first
   * insertPatientHandOffData with no state change in between (a dead call) -
   * that duplicate is intentionally not replicated here since it has no
   * observable effect; everything else follows the Java sequence exactly,
   * including insertAreaOfCareinforamtionOperative's hardcoded moduleId=1020
   * and the no-arg getAreaCareInformationsbyCase() call in the Pre-Operative
   * block (not the department-scoped overload).
   */
  async dischargePatient(dischargeDetails: string, procedureDt: string, preoperationdetails: string | undefined): Promise<void> {
    let departmentName: string;
    let userID: string;
    let dischargedTo: string | null = null;
    if (dischargeDetails.includes(';')) {
      const parts = dischargeDetails.split(';');
      departmentName = parts[0];
      userID = parts[1];
      dischargedTo = parts[2] ?? null;
    } else {
      departmentName = 'Recovery';
      userID = dischargeDetails;
    }

    await this.getStaffDetails(userID);
    await this.getCaseDetailInformation(departmentName);
    await this.getFormByName();
    await this.getFormUsagebyByFormOwner();
    await this.updateFormUsagebyByFormOwner();
    await this.getAreaCareInformationsbyCase();
    await this.getModulesBycaseId(departmentName);

    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID)!;
    await this.updateCaseStatus(caseSummaryId, '0');

    await this.requestModuleLock();
    await this.getAreaCareInformationsbyCase(departmentName);
    await this.insertAreaOfCareInformation(procedureDt);
    await this.saveAreaOfCareStaffDetails();
    await this.getAreaCareInformationsbyCase(departmentName);
    await this.insertPatientHandOffData(4, 0, null);
    await this.saveAreaOfCareStaffDetails();
    await this.insertPatientHandOffData(10, 10, dischargedTo);
    await this.saveAreaOfCareStaffDetails();
    await this.requestModuleLock();
    await this.upsertCaseSummaryInfo('10', '10', '04');
    await this.releaseModuleLock(departmentName);

    if (!isBlank(preoperationdetails)) {
      const preOpDepartment = 'Pre-Operative';
      await this.requestModuleLockForDepartment(preOpDepartment);
      await this.getAreaCareInformationsbyCase();
      await this.insertAreaOfCareinforamtionOperative(preoperationdetails!, procedureDt);
      await this.releaseModuleLock(preOpDepartment);
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.addMedication/addMedicationtopatient. Branches on
   * whether the org has the "Orders" feature enabled: the Orders path creates a
   * physician-order container, attaches each medication as an order, then
   * administers every order found for the department; the legacy path posts
   * medication template ids directly and administers via the older endpoint.
   */
  async addMedication(userName: string, medicationname: string, departmentname: string): Promise<void> {
    await this.getCaseDetailInformation(departmentname);
    const isOrdersEnabled = await this.isFeatureEnabled('Orders');

    if (isOrdersEnabled) {
      await this.createCasePhysicianOrderId(departmentname);
      await this.getCasePhysicianOrderId(departmentname);
      await this.addMedicationToOrders(medicationname, departmentname);
      await this.administerMedicationsInOrders(departmentname);
      return;
    }

    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID);
    const moduleId = Number(this.responseCache.getString(Keys.KEY_MODULE_ID));
    const templateIdList = await this.getMedicationTemplateIds(medicationname);
    await this.runWebServiceRequest(
      { caseSummaryId, moduleId, medicationList: [], templateIdList },
      '/Medication/AddMedications',
      'POST'
    );

    await this.insertMedicationAdministrations(userName);
  }

  /**
   * Port of WebServiceClient.createInsuranceContract. insuranceContractName is a
   * ';'-separated list of contract names to create in one row; every other
   * param is independently ';'-split and indexed alongside it. Skip-if-exists:
   * matching Java, a contract that already exists (by name) is left as-is - no
   * update path, just a duplicate-check log.
   */
  async createInsuranceContract(
    username: string,
    password: string,
    facility: string,
    insuranceContractName: string,
    effectiveDate: string,
    expirationDate: string,
    contractType: string,
    percentOfBilledCharge: string,
    transactionCodeName: string,
    writeOffGroupId: string,
    writeOffReasonId: string,
    procedure1: string,
    procedure2: string,
    procedure3: string,
    procedure4: string,
    procedure5: string,
    addtionalProcedure: string,
    groupIndx: string,
    reimbursement: string
  ): Promise<void> {
    await this.createSession(facility, username, password);

    const names = insuranceContractName.split(';');
    const effectiveDates = effectiveDate.split(';');
    const expirationDates = expirationDate.split(';');
    const contractTypes = contractType.split(';');
    const percentOfBilledCharges = percentOfBilledCharge.split(';');
    const transactionCodeNames = transactionCodeName.split(';');
    const writeOffGroupIds = writeOffGroupId.split(';');
    const writeOffReasonIds = writeOffReasonId.split(';');
    const procedure1s = procedure1.split(';');
    const procedure2s = procedure2.split(';');
    const procedure3s = procedure3.split(';');
    const procedure4s = procedure4.split(';');
    const procedure5s = procedure5.split(';');
    const addtionalProcedures = addtionalProcedure.split(';');
    const groupIndxs = groupIndx.split(';');
    const reimbursements = reimbursement.split(';');

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (isBlank(name)) continue;

      const existing = await this.retrieveContracts(name);
      if (existing) continue;

      await this.saveContract(name, effectiveDates[i] ?? '', expirationDates[i] ?? '', contractTypes[i] ?? '');
      await this.selectContractOptions(
        contractTypes[i] ?? '',
        percentOfBilledCharges[i] ?? '',
        transactionCodeNames[i] ?? '',
        writeOffGroupIds[i] ?? '',
        writeOffReasonIds[i] ?? ''
      );

      if ((contractTypes[i] ?? '').toLowerCase() === 'grouper') {
        await this.updateFeeGroupsForGrouperContract(groupIndxs[i] ?? '', reimbursements[i] ?? '');
      }

      const procedures = [procedure1s[i], procedure2s[i], procedure3s[i], procedure4s[i], procedure5s[i], addtionalProcedures[i]];
      for (let p = 0; p < procedures.length; p++) {
        if (!isBlank(procedures[p])) {
          await this.selectProcedureDiscount(procedures[p]!, p + 1);
        }
      }
    }
  }

  /**
   * Port of WebServiceClient.createDictionaryItem. DictionaryitemName/Dictionaryname/value
   * are each ';'-separated to support multiple items per row, indexed together.
   */
  async createDictionaryItem(
    userName: string,
    password: string,
    facility: string,
    dictionaryname: string,
    dictionaryitemName: string,
    value: string
  ): Promise<void> {
    const itemNames = dictionaryitemName.split(';');
    const dictNames = dictionaryname.split(';');
    const values = value.split(';');

    for (let i = 0; i < itemNames.length; i++) {
      if (isBlank(itemNames[i])) continue;
      await this.createSession(facility, userName, password);
      const showInClinicalTf = String(values[i]).toLowerCase() === 'true';
      await this.createDictionary(dictNames[i] ?? dictNames[0], itemNames[i], showInClinicalTf);
    }
  }

  /**
   * Port of WebServiceClient.createCaseFlags. All five params are ','-separated,
   * indexed together per case flag. Unlike Java (which silently swallows all
   * errors here via printStackTrace with no rethrow), errors are allowed to
   * surface here for consistency with the rest of this port.
   */
  async createCaseFlags(facility: string, caseFlagName: string, abbreviation: string, color: string, flagVisibility: string): Promise<void> {
    if (isBlank(caseFlagName)) return;

    const facilities = facility.split(',');
    const caseFlagNames = caseFlagName.split(',');
    const abbreviations = abbreviation.split(',');
    const colors = color.split(',');
    const flagVisibilities = flagVisibility.split(',');

    const visibilityMap: Record<string, number> = { business: 2, clinical: 1, both: 3 };

    for (let i = 0; i < caseFlagNames.length; i++) {
      const normalize = (v: string | undefined) => (v?.toLowerCase() === 'blank' ? '' : v ?? '');
      const caseFlag = normalize(caseFlagNames[i]);
      const abbr = normalize(abbreviations[i]);
      const colorValue = normalize(colors[i]);
      const visibility = normalize(flagVisibilities[i]);

      await this.createSession(facilities[i] ?? facilities[0]);
      const colorObj = await this.getCaseFlagColors(colorValue);

      const body = {
        caseFlagColorId: Number(colorObj.caseFlagColorId),
        caseFlagColor: colorObj,
        caseFlagName: caseFlag,
        abbreviation: abbr,
        caseFlagVisibility: visibilityMap[visibility.toLowerCase()] ?? 0,
      };

      // Multiple case-flag rows can target the same organization's record lock
      // concurrently; a losing row's lock request can be pre-empted by another
      // row's, so retry the acquire/post/release cycle a few times before failing.
      await this.retryOnTransientError(
        async () => {
          await this.performCaseFlagLock(true);
          await this.runWebServiceRequest(body, '/CaseFlag/Config', 'POST');
          await this.performCaseFlagLock(false);
        },
        (message) => /No valid record lock exists/i.test(message)
      );
    }
  }

  /**
   * Port of WebServiceClient.createPhysicianOpNotes. This is the config-level op-notes
   * operation (/OpNoteConfiguration/*) - distinct from PatientCreation's per-case
   * addOPNotesToPatient (/OpNoteDocumentation/*). OpNoteName/physicianname/opNoteText
   * are each ';'-separated, indexed together. Skip-if-exists, matching Java.
   */
  async createPhysicianOpNotes(
    userName: string,
    password: string,
    facility: string,
    opNoteName: string,
    physicianname: string,
    opNoteText: string
  ): Promise<void> {
    const names = opNoteName.split(';');
    const physicians = physicianname.split(';');
    const texts = opNoteText.split(';');

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (isBlank(name)) continue;

      await this.createSession(facility, userName, password);

      const alreadyPresent = await this.getPhysicianOpNotesDetails(name);
      if (alreadyPresent) continue;

      const opNoteId = await this.opNoteConfigurationAdd(name);
      await this.updateOpNoteConfiguration(opNoteId, name, physicians[i] ?? physicians[0], texts[i] ?? texts[0]);
    }
  }

  /**
   * Port of WebServiceClient.createDiscounts (Java method name differs from the
   * seed-data operation name "createNewDiscounts"). discountName is ';'-separated;
   * the other four params are independently ';'-split and indexed alongside it,
   * falling back to the last successfully-indexed value when an index is missing
   * (matching Java's try/catch-and-keep-previous-value behavior).
   */
  async createDiscounts(
    userName: string,
    password: string,
    facility: string,
    discountName: string,
    writeOffGroupCode: string,
    writeOffReasonCode: string,
    transactionCodeName: string,
    discountpercent: string
  ): Promise<void> {
    if (this.token === null) {
      await this.createSession(facility, userName, password);
    }

    const names = discountName.split(';');
    const writeOffGroupCodes = writeOffGroupCode.split(';');
    const writeOffReasonCodes = writeOffReasonCode.split(';');
    const transactionCodeNames = transactionCodeName.split(';');
    const discountpercents = discountpercent.split(';');

    let currentGroupCode = writeOffGroupCode;
    let currentReasonCode = writeOffReasonCode;
    let currentTransactionCodeName = transactionCodeName;
    let currentDiscountpercent = discountpercent;

    for (let i = 0; i < names.length; i++) {
      if (isBlank(names[i])) continue;
      if (writeOffGroupCodes[i] !== undefined) currentGroupCode = writeOffGroupCodes[i];
      if (writeOffReasonCodes[i] !== undefined) currentReasonCode = writeOffReasonCodes[i];
      if (transactionCodeNames[i] !== undefined) currentTransactionCodeName = transactionCodeNames[i];
      if (discountpercents[i] !== undefined) currentDiscountpercent = discountpercents[i];

      await this.createSaveSourceOfRevenue(names[i], currentGroupCode, currentReasonCode, currentTransactionCodeName, currentDiscountpercent);
    }
  }

  /**
   * Port of WebServiceClient.createMessageTemplate. templateName/desktop/messageType/body/
   * emailSubject are each '|'-separated to support multiple templates in one row.
   */
  async createMessageTemplate(
    userId: string,
    password: string,
    facilityName: string,
    templateName: string,
    desktop: string,
    messageType: string,
    body: string,
    emailSubject: string
  ): Promise<void> {
    await this.createSession(facilityName, userId, password);

    const names = templateName.split('|');
    const desktops = desktop.split('|');
    const messageTypes = messageType.split('|');
    const bodies = body.split('|');
    const emailSubjects = emailSubject.split('|');

    for (let i = 0; i < names.length; i++) {
      await this.addMessageTemplate(names[i], desktops[i] ?? desktops[0], messageTypes[i] ?? messageTypes[0], bodies[i] ?? bodies[0], emailSubjects[i] ?? emailSubjects[0]);
    }
  }

  /**
   * Port of WebServiceClient.createMedication / ReUsableWebserviceUtils.createMedicationTemplate.
   * Only the plain ("NA") medication path is ported - compound ("false") and titrated ("true")
   * throw a clear "not yet ported" error, matching this port's established pattern for
   * partially-implemented branches (0 rows in the current seed data use anything but "NA").
   */
  async createMedication(
    username: string,
    password: string,
    facility: string,
    medication: string,
    searchString: string,
    fullMedication: string,
    department: string | undefined,
    speciality: string | undefined,
    templateName: string,
    isTitrated: string
  ): Promise<void> {
    await this.createSession(facility, username, password);

    if (isTitrated.toLowerCase() !== 'na') {
      throw new Error(`createMedication: only the "NA" (plain) medication path is ported - isTitrated was "${isTitrated}"`);
    }

    const titratedDrug = await this.getTitratedDrugs(searchString);
    const dispensableDrugObject = await this.getDispensableDrugNames(Number(titratedDrug.drugNameID), fullMedication);
    const body = await this.getMedicationObject(titratedDrug, dispensableDrugObject, department, speciality, templateName);
    await this.insertMedicationTemplate(body);
  }

  /**
   * Port of WebServiceClient.createPreferenceCards. preferenceCardNames is ';'-separated;
   * every other param is independently ';'-split and indexed alongside it.
   */
  async createPreferenceCards(
    facility: string,
    preferenceCardNames: string,
    caseSpecialtiy: string,
    appointmentTypeValue: string,
    physician: string,
    anesthesiaTypeValue: string,
    caseFlags: string,
    physicianOrders: string,
    opNotes: string,
    consents: string,
    dischargeInstructions: string,
    preAdmissionQxWorklists: string,
    preAdmissionInstructionsWorklists: string,
    preOperativeWorklists: string,
    operativeWorklists: string,
    phase1Worklists: string,
    phase2Worklists: string,
    phase3Worklists: string,
    recoveryWorklist: string,
    postoperativeQXWorklists: string,
    implantNames: string,
    manfacturerNames: string,
    size: string,
    lotNum: string,
    serialNum: string,
    expiration: string,
    referenceNum: string,
    quantity: string,
    implantnotes: string,
    supplyName: string,
    prOpen: string,
    prHold: string,
    orOpen: string,
    orHold: string,
    p3Open: string,
    p3Hold: string,
    supplyNotes: string,
    equipmentNames: string,
    serialNumbers: string,
    equipmentNotes: string,
    cptCodes: string
  ): Promise<void> {
    await this.createSession(facility);

    const names = preferenceCardNames.split(';');
    const at = (s: string, i: number) => s.split(';')[i];

    for (let i = 0; i < names.length; i++) {
      if (isBlank(names[i])) continue;
      await this.addPreferenceCard(
        names[i],
        at(caseSpecialtiy, i),
        at(appointmentTypeValue, i),
        at(physician, i),
        at(anesthesiaTypeValue, i),
        at(caseFlags, i),
        at(physicianOrders, i),
        at(opNotes, i),
        at(consents, i),
        at(dischargeInstructions, i),
        at(preAdmissionQxWorklists, i),
        at(preAdmissionInstructionsWorklists, i),
        at(preOperativeWorklists, i),
        at(operativeWorklists, i),
        at(phase1Worklists, i),
        at(phase2Worklists, i),
        at(phase3Worklists, i),
        at(recoveryWorklist, i),
        at(postoperativeQXWorklists, i),
        at(implantNames, i),
        at(manfacturerNames, i),
        at(size, i),
        at(lotNum, i),
        at(serialNum, i),
        at(expiration, i),
        at(referenceNum, i),
        at(quantity, i),
        at(implantnotes, i),
        at(supplyName, i),
        at(prOpen, i),
        at(prHold, i),
        at(orOpen, i),
        at(orHold, i),
        at(p3Open, i),
        at(p3Hold, i),
        at(supplyNotes, i),
        at(equipmentNames, i),
        at(serialNumbers, i),
        at(equipmentNotes, i),
        at(cptCodes, i)
      );
    }
  }

  /**
   * Port of WebServiceClient.createAnesthesiaOrders. ordername is '|'-separated; for each
   * order, department/departmentOrderstext are ','-split and paired by index.
   */
  async createAnesthesiaOrders(facility: string, ordername: string, department: string, departmentOrderstext: string): Promise<void> {
    await this.createSession(facility);

    const departments = department.split(',');
    const orderTexts = departmentOrderstext.split(',');

    for (const orderName of ordername.split('|')) {
      await this.addNewOrder(orderName, '/AnestehesiaOrdersConfiguration/Insert');
      if (!isBlank(department)) {
        for (let i = 0; i < orderTexts.length; i++) {
          await this.updateBaseOrder(departments[i] ?? departments[0], orderTexts[i]);
        }
      }
    }
  }

  /**
   * Port of WebServiceClient.createPhysicianOrders. Ordername/Physician/Department/
   * DepartmentOrderstext are each ';'-separated, indexed together (missing splits
   * silently keep the prior value, matching Java's try/catch-and-ignore behavior).
   */
  async createPhysicianOrders(
    userName: string,
    password: string,
    facility: string,
    ordername: string,
    physician: string,
    department: string,
    departmentOrderstext: string
  ): Promise<void> {
    const names = ordername.split(';');
    const physicians = physician.split(';');
    const departments = department.split(';');
    const orderTextsByOrder = departmentOrderstext.split(';');

    let currentPhysician = physician;
    let currentDepartment = department;
    let currentOrderText = departmentOrderstext;

    for (let i = 0; i < names.length; i++) {
      if (isBlank(names[i])) continue;
      if (physicians[i] !== undefined) currentPhysician = physicians[i];
      if (departments[i] !== undefined) currentDepartment = departments[i];
      if (orderTextsByOrder[i] !== undefined) currentOrderText = orderTextsByOrder[i];

      await this.createSession(facility, userName, password);
      await this.addNewOrder(names[i], '/PhysicianOrdersConfiguration');
      await this.updatePhysiciansForOrder(currentPhysician);

      if (!isBlank(currentDepartment)) {
        for (const orderText of currentOrderText.split(',')) {
          await this.updateBaseOrder(currentDepartment, orderText);
        }
      }
    }
  }

  /**
   * Port of WebServiceClient.createAnesthesiaBlock. anesthesiBlockNote/facility/blockNoteTexArea
   * are each '|'-separated, indexed together (facility is split per-block-note here, unlike
   * most other operations where it's a single value).
   */
  async createAnesthesiaBlock(facility: string, anesthesiBlockNote: string, blockNoteTexArea: string): Promise<void> {
    const facilities = facility.split('|');
    const textAreas = blockNoteTexArea.split('|');
    const blockNotes = anesthesiBlockNote.split('|');

    for (let i = 0; i < blockNotes.length; i++) {
      await this.createSession(facilities[i] ?? facilities[0]);
      const blockNoteId = await this.addAnesthesiaBlockNote(blockNotes[i]);
      await this.updateAnesBlockNote(blockNotes[i], blockNoteId, textAreas[i] ?? '');
    }
  }

  /**
   * Port of WebServiceClient.createBlockNotes. blockNames is '|'-separated; every other
   * param is independently '|'-split and indexed alongside it.
   */
  async createBlockNotes(
    facility: string,
    blockNames: string,
    rooms: string,
    physicians: string,
    dates: string,
    startTimes: string,
    endTimes: string,
    specialitys: string,
    blockColors: string,
    blockOuts: string
  ): Promise<void> {
    if (isBlank(blockNames)) return;
    await this.createSession(facility);

    const names = blockNames.split('|');
    const at = (s: string, i: number) => s.split('|')[i];

    for (let i = 0; i < names.length; i++) {
      await this.createBlockNote(
        names[i],
        at(rooms, i),
        at(physicians, i),
        at(dates, i),
        at(startTimes, i),
        at(endTimes, i),
        at(specialitys, i),
        at(blockColors, i),
        at(blockOuts, i)
      );
    }
  }

  /**
   * Port of WebServiceClient.updateSuppliesToContract. contractName is '|'-separated;
   * every other param is independently '|'-split and indexed alongside it. Matching
   * Java, failures here are swallowed (logged only, not rethrown) since the original
   * has its throw commented out "until the duplicate check has implemented".
   */
  async updateSuppliesToContract(
    facility: string,
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
    if (isBlank(contractName)) return;

    const at = (s: string, i: number) => s.split('|')[i];
    const contractNames = contractName.split('|');

    for (let i = 0; i < contractNames.length; i++) {
      try {
        await this.createSession(facility);
        await this.upsertPricingOptionConfigItem(
          contractNames[i],
          at(revenueCode, i),
          at(revCodePostingMethod, i),
          at(revCodefeeOrCostPercentage, i),
          at(supplyCostMin, i),
          at(supplyCostMax, i),
          at(supplyCostPostingMethod, i),
          at(supplyCostfeeOrCostPercentage, i),
          at(supplyCategory, i),
          at(supplyCategoryPostingMethod, i),
          at(supplyCategoryfeeOrCostPercentage, i),
          at(supplyItemName, i),
          at(supplyItemPostingMethod, i),
          at(supplyItemfeeOrCostPercentage, i)
        );
      } catch (err) {
        console.warn(`[WebServiceClient] updateSuppliesToContract: row failed (suppressed, matching Java original):`, err);
      }
    }
  }

  /**
   * Port of WebServiceClient.createUsers. firstName/middleInitial/lastName/businessfacility/
   * profileName/roleName/emailAddress/title/isEnterprise are each ';'-separated for multi-user
   * rows. Unlike Java (which supports ','-separated multiple business facilities/profiles/roles
   * per user, assigning every facility x profile x role combination), this only supports one
   * facility/profile/role per user - the current seed data never uses the ','-separated form.
   */
  async createUsers(
    userName: string,
    password: string,
    facility: string,
    firstName: string,
    middleInitial: string,
    lastName: string,
    businessfacility: string,
    profileName: string,
    roleName: string,
    emailAddress: string | undefined,
    title: string,
    isEnterprise: string | undefined
  ): Promise<void> {
    const firstNames = firstName.split(';');
    const middleInitials = middleInitial.split(';');
    const lastNames = lastName.split(';');
    const businessFacilities = businessfacility.split(';');
    const profileNames = profileName.split(';');
    const roleNames = roleName.split(';');
    const titles = title.split(';');
    const emailAddresses = emailAddress?.split(';') ?? [];
    const enterpriseFlags = isEnterprise?.split(';') ?? [];

    for (let i = 0; i < firstNames.length; i++) {
      await this.createSession(facility, userName, password);
      const [personId, usrId] = await this.createNewUser(firstNames[i], middleInitials[i] ?? '', lastNames[i], titles[i] ?? '');

      if (!isBlank(businessFacilities[i])) {
        await this.setUserOrganizationAssignment(usrId, personId, businessFacilities[i], profileNames[i] ?? profileNames[0], roleNames[i] ?? roleNames[0]);
      }
      if (enterpriseFlags[i]?.toLowerCase() === 'true') {
        await this.turnOnEnterpriseAccess(usrId);
      }
      if (!isBlank(emailAddresses[i])) {
        await this.updateEmailUser(emailAddresses[i], personId);
      }
    }
  }

  /**
   * Port of ReUsableWebserviceUtils.cancelPatient (/CaseSummary/Gemini/UpsertCaseStatus, POST).
   * Looks up the cancel reason from dictionary id 154 (cancel-case-reason dictionary).
   */
  async cancelPatient(cancelCaseTemplateName: string): Promise<void> {
    const cancelCaseTemplates = await this.getDictionaryItems('154');
    const cancelCaseTemplate = findByField(cancelCaseTemplates, 'value', cancelCaseTemplateName);
    if (!cancelCaseTemplate) {
      throw new Error(`cancelPatient: no cancel-case template found with value "${cancelCaseTemplateName}"`);
    }
    const caseSummaryId = this.responseCache.getString(Keys.KEY_CASE_SUMMARY_ID);
    const body = {
      caseSummaryId: Number(caseSummaryId),
      status: 1,
      cancelCaseReason: cancelCaseTemplateName,
      cancelCaseReasonId: cancelCaseTemplate.id,
      cancelDate: `${addDate('Today', 'yyyy-MM-dd')}T21:09:20.139Z`,
    };
    await this.runWebServiceRequest(body, '/CaseSummary/Gemini/UpsertCaseStatus', 'POST');
  }

  /**
   * Port of ReUsableWebserviceUtils.updateCaseSummaryWithGuarantorAdditionalInformation.
   * guarantorAdditionalDetails is a ';'-separated list (one entry per caseGuarantor[index]),
   * each a fixed-position ','-separated set of fields (gender, relationship, primaryPhone,
   * address1, address2, city, state, zip, extendedZip, dateOfBirth). Only guarantors with a
   * non-zero patientGuarantor.patientId are updated, matching the Java original.
   */
  private async updateCaseSummaryWithGuarantorAdditionalInformation(guarantorAdditionalDetails: string): Promise<void> {
    const relURL = '/CaseSummaryComplex/Gemini/UpsertCaseSummary';
    const caseSummaryRaw = this.responseCache.get<string>(Keys.KEY_CASE_SUMMARY_RESPONSE);
    if (!caseSummaryRaw) {
      throw new Error('updateCaseSummaryWithGuarantorAdditionalInformation: no cached case summary response');
    }
    const caseSummary = JSON.parse(caseSummaryRaw) as Record<string, unknown>;
    const caseGuarantors = caseSummary.caseGuarantor as Record<string, unknown>[];
    const detailsPerGuarantor = guarantorAdditionalDetails.split(';');

    for (let index = 0; index < caseGuarantors.length; index++) {
      const caseGuarantor = caseGuarantors[index];
      const patientGuarantor = caseGuarantor.patientGuarantor as Record<string, unknown>;

      if (Number(patientGuarantor.patientId) !== 0) {
        const detailsRaw = detailsPerGuarantor[index];
        if (detailsRaw && detailsRaw.toLowerCase() !== 'blank') {
          const fields = detailsRaw.split(',');
          const orNull = (v: string | undefined) => (v && v.toLowerCase() !== 'blank' ? v : null);
          patientGuarantor.gender = orNull(fields[0]);
          patientGuarantor.patientRelationship = orNull(fields[1]);
          patientGuarantor.phoneNumber = orNull(fields[2]);
          patientGuarantor.address1 = orNull(fields[3]);
          patientGuarantor.address2 = orNull(fields[4]);
          // Java's city/state branches have an inverted condition (sets the literal
          // string "blank" when blank, null otherwise) - that looks like a copy-paste
          // bug rather than intended behavior, so this port uses the same orNull
          // pattern as every other field here instead of replicating it.
          patientGuarantor.city = orNull(fields[5]);
          patientGuarantor.state = orNull(fields[6]);
          const zipCode = orNull(fields[7]);
          patientGuarantor.zip = zipCode ? `${zipCode}-${fields[8]}` : null;
          patientGuarantor.dateOfBirth = orNull(fields[9]);
        }
      }
      caseGuarantor.patientGuarantor = patientGuarantor;
    }
    caseSummary.caseGuarantor = caseGuarantors;

    const response = await this.runWebServiceRequest(caseSummary, relURL, 'POST');
    this.responseCache.put(Keys.KEY_CASE_SUMMARY_RESPONSE, response.raw);
  }
}
