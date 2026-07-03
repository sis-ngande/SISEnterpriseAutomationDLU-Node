import axios, { AxiosInstance, Method } from 'axios';
import { ResponseCache } from './responseCache';
import { TemplateLoader, updateField } from '../../templates/templateLoader';
import * as Keys from './iWebServiceResponseKeys';

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
    const headers: Record<string, string> = {};
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
      throw new Error(`Failure response for api: ${endPoint} (status ${response.status})`);
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

  private getUserSessionOrg(response: unknown, orgName: string): string {
    const arr = Array.isArray(response) ? response : JSON.parse(String(response));
    const childOrgs = arr[0]?.childOrgs ?? [];
    const match = childOrgs.find((o: { name: string }) => o.name === orgName);
    if (!match) {
      throw new Error(`Organization not found in UserOrgMap response - ${orgName}`);
    }
    return String(match.organizationId);
  }
}
