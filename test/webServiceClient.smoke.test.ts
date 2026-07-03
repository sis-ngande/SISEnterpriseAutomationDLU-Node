import http from 'http';
import { AddressInfo } from 'net';
import path from 'path';
import { WebServiceClient } from '../src/client/webservice/webServiceClient';
import { ResponseCache } from '../src/client/webservice/responseCache';
import { SeedData } from '../src/seeddata/seedData';

/**
 * End-to-end smoke test for the ported createNewRoom flow: spins up a real
 * HTTP server mocking the backend (login, org map, room-type add, room add)
 * and drives WebServiceClient.callWebService against it over real HTTP,
 * asserting the request sequence and bodies match what WebServiceClient.java
 * (createSession + createNewRoom, lines 370-411) sends.
 */
describe('WebServiceClient - createNewRoom (ported from WebServiceClient.java L370-411)', () => {
  let server: http.Server;
  let baseURL: string;
  const requests: { method: string; url: string; body: unknown }[] = [];

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
        } else if (req.url === '/RoomType/Add' || req.url === '/Room/Add') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
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

  it('sends login -> org map -> org select -> room type add -> room add, in order, with correct bodies', async () => {
    const responseCache = new ResponseCache();
    const templatesDir = path.resolve(__dirname, '../reqTemplates');
    const client = new WebServiceClient(baseURL, responseCache, templatesDir);

    const operations = new Map([['Room Details', new Map([['facility', 'FacilityA'], ['roomName', 'OR-101']])]]);
    const sd = new SeedData('tc-1', 10, operations);

    await client.callWebService(sd);

    expect(requests.map((r) => r.url)).toEqual([
      '/login/loginuser',
      '/User/UserOrgMap',
      '/UserSession/UserSessionOrg/343',
      '/RoomType/Add',
      '/Room/Add',
    ]);

    const roomTypeAdd = requests.find((r) => r.url === '/RoomType/Add')!.body as Record<string, unknown>;
    expect(roomTypeAdd.roomTypeDesc).toBe('RTyp OR-101');
    expect(roomTypeAdd.quickCode).toBe('RTyp OR-101');

    const roomAdd = requests.find((r) => r.url === '/Room/Add')!.body as Record<string, unknown>;
    expect(roomAdd.name).toBe('OR-101');
    expect(roomAdd.quickCode).toBe('OR-101');
    expect(roomAdd.organizationId).toBe(343);
    expect(roomAdd.roomTypeId).toBe(roomTypeAdd.roomTypeId);

    expect(responseCache.getString('keyOrgId')).toBe('343');
    expect(responseCache.getString('keyToken')).toBe('fake-token-123');
  });

  it('splits multiple room names on ";" and creates one room-type/room pair per name', async () => {
    requests.length = 0;
    const responseCache = new ResponseCache();
    const templatesDir = path.resolve(__dirname, '../reqTemplates');
    const client = new WebServiceClient(baseURL, responseCache, templatesDir);

    const operations = new Map([['Room Details', new Map([['facility', 'FacilityA'], ['roomName', 'OR-1;OR-2']])]]);
    const sd = new SeedData('tc-2', 11, operations);

    await client.callWebService(sd);

    const roomAddCalls = requests.filter((r) => r.url === '/Room/Add');
    expect(roomAddCalls.map((r) => (r.body as Record<string, unknown>).name)).toEqual(['OR-1', 'OR-2']);
  });

  it('logs and skips unimplemented operations without throwing', async () => {
    requests.length = 0;
    const responseCache = new ResponseCache();
    const templatesDir = path.resolve(__dirname, '../reqTemplates');
    const client = new WebServiceClient(baseURL, responseCache, templatesDir);

    const operations = new Map([
      ['PatientCreation', new Map([['firstName', 'John']])],
      ['Room Details', new Map([['facility', 'FacilityA'], ['roomName', 'OR-9']])],
    ]);
    const sd = new SeedData('tc-3', 12, operations);

    await expect(client.callWebService(sd)).resolves.toBeUndefined();
    expect(requests.some((r) => r.url === '/Room/Add')).toBe(true);
  });
});
