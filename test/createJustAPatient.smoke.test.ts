import http from 'http';
import { AddressInfo } from 'net';
import path from 'path';
import { WebServiceClient } from '../src/client/webservice/webServiceClient';
import { ResponseCache } from '../src/client/webservice/responseCache';

/**
 * End-to-end smoke test for the ported createJustAPatient flow
 * (ReUsableWebserviceUtils.java L420-495): login -> religion/race dictionary
 * lookups -> CreatePatient POST, verified against a real mock HTTP server.
 */
describe('WebServiceClient - createJustAPatient (ported from ReUsableWebserviceUtils.java L420-495)', () => {
  let server: http.Server;
  let baseURL: string;
  let requests: { method: string; url: string; body: unknown }[];

  const dictionaries = [
    { id: 10, name: 'Religion' },
    { id: 11, name: 'Race' },
  ];
  const religionItems = [{ id: 101, value: 'Catholic' }];
  const raceItems = [{ id: 201, value: 'Asian' }];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : undefined;
        requests.push({ method: req.method!, url: req.url!, body });

        if (req.url === '/login/loginuser') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('"fake-token-123"');
        } else if (req.url === '/User/UserOrgMap') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([{ childOrgs: [{ name: 'FacilityA', organizationId: 343 }] }]));
        } else if (req.url?.startsWith('/UserSession/UserSessionOrg/')) {
          res.writeHead(200);
          res.end('{}');
        } else if (req.url === '/Dictionary/v2') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(dictionaries));
        } else if (req.url === '/Dictionary/v2/10/All') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(religionItems));
        } else if (req.url === '/Dictionary/v2/11/All') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(raceItems));
        } else if (req.url === '/PatientData/Gemini/CreatePatient/2030') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"patientId": 999}');
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseURL = `http://localhost:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    requests = [];
  });

  it('creates a patient with core fields, ethnicity mapping, and religion/race dictionary lookups', async () => {
    const responseCache = new ResponseCache();
    const templatesDir = path.resolve(__dirname, '../reqTemplates');
    const client = new WebServiceClient(baseURL, responseCache, templatesDir);
    await client.createSession('FacilityA');

    await client.createJustAPatient({
      firstName: 'Gem_Org003',
      lastName: 'TestLast',
      dateOfBirth: '01/02/1980',
      procedureDt: 'Today',
      patientGender: 'Male',
      religion: 'Catholic',
      ethnicity: 'Hispanic',
      race: 'Asian',
    });

    const createPatientCall = requests.find((r) => r.url === '/PatientData/Gemini/CreatePatient/2030');
    expect(createPatientCall).toBeDefined();
    const body = createPatientCall!.body as Record<string, unknown>;

    expect(body.firstName).toBe('Gem_Org003');
    expect(body.lastName).toBe('TestLast');
    expect(body.dateOfBirth).toBe('01/02/1980');
    expect(body.fullName).toBe('Gem_Org003 TestLast');
    expect(body.gender).toBe('Male');
    expect(body.ethnicityId).toBe(1);
    expect(body.ethnicity).toBe('Hispanic');
    expect(body.religionId).toBe(101);
    expect(body.religion).toBe('Catholic');
    expect(body.raceId).toBe(201);
    expect(body.race).toBe('Asian');
    expect(body.middleInitial).toBe('M');
    expect(String(body.procedureDt)).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00-0500$/);
    expect(String(body.accountNumber)).toHaveLength(13);
  });

  it('throws rather than silently drop data when an unported detail field is populated', async () => {
    const responseCache = new ResponseCache();
    const templatesDir = path.resolve(__dirname, '../reqTemplates');
    const client = new WebServiceClient(baseURL, responseCache, templatesDir);
    await client.createSession('FacilityA');

    await expect(
      client.createJustAPatient({
        firstName: 'A',
        lastName: 'B',
        procedureDt: 'Today',
        patientAddressDetails: '123 Main St',
      })
    ).rejects.toThrow(/patientAddressDetails is not yet ported/);
  });
});
