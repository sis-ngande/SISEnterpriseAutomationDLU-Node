import { WebserviceUtils } from './webserviceUtils';
import { ResponseCache } from './responseCache';
import { SeedData } from '../../seeddata/seedData';
import { generateRandomNumeric } from '../../utils/reusableUtils';
import * as Keys from './iWebServiceResponseKeys';
import { updateField } from '../../templates/templateLoader';

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
}
