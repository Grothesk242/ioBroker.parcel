'use strict';

const crypto = require('crypto');

/**
 * DPD Paketnavigator SOAP-Client.
 *
 * Nachbau des Auth-/Fetch-Flows der offiziellen DPD-Android-App v4.1.2
 * (Paketnavigator3, package `de.dpd.mobile`).
 *
 * Endpoint:   https://api.paketnavigator.de/services/v1/Navigator3Service.asmx
 * Namespace:  https://cloud.dpd.com/
 * SOAPAction: https://cloud.dpd.com/<operationName>
 *
 * Partner-Credentials und KeyPhase-Algorithmus stammen aus
 * com/dpd/navigator/utils/APIHelper.smali der APK. Die KeyPhase ist ein
 * zeitabhängiger MD5-Hash aus
 *   timeSeed + PartnerName + cloudUserId + endpointName + PartnerPassword,
 * gültig ~1 Minute.
 */

const NS = 'https://cloud.dpd.com/';
const SERVICE_URL = 'https://api.paketnavigator.de/services/v1/Navigator3Service.asmx';
const PARTNER_NAME = 'Android Paketnavigator3';
const PARTNER_TOKEN = 'A33363237662F5945576';
const PARTNER_PASSWORD = '272 WetFd2mpXrgD';
const API_VERSION = 100;
const LANGUAGE = 'de_DE';

// ---------- kleine XML- / Crypto-Helper ----------

function computeKeyPhase(cloudUserId, endpointName) {
  const now = new Date();
  const timeSeed = String((now.getUTCHours() * 60 + now.getUTCMinutes() + 1000) * 3);
  const input = timeSeed + PARTNER_NAME + String(cloudUserId || 0) + endpointName + PARTNER_PASSWORD;
  const md5b64 = crypto.createHash('md5').update(input, 'utf-8').digest('base64');
  return timeSeed + md5b64.substring(0, 16);
}

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Extrahiert (und dekodiert) den Inhalt des ersten Vorkommens von `<tag>` aus
 * einem XML-String. Toleriert Namespace-Präfixe, self-closing Tags und Attribute
 * mit `/`-Zeichen in Werten. Absichtlich einfach — der DPD-SOAP-Response ist
 * stabil UTF-8 ohne CDATA/Kommentare.
 *
 * Bug-Ecke die vermieden wird: einige DPD-Responses enthalten dieselben
 * Tag-Namen in verschiedenen Container-Blöcken (z.B. `<ParcelNo>abc</ParcelNo>`
 * ganz oben und weiter unten in einem `<VideoGreetingsData>`-Substruct ein
 * self-closing `<ParcelNo />`). Wir suchen deshalb das *erste* öffnende Tag
 * und entscheiden dort, ob es sich um self-closing handelt.
 */
function pickXml(xml, tag) {
  if (!xml) return null;
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagPattern = '(?:[a-zA-Z_][\\w.-]*:)?' + escaped;
  // Finde das erste öffnende Tag; capture zeigt ob self-closing (`/>`) oder mit Body
  const openRe = new RegExp('<' + tagPattern + '(?:\\s[^>]*?)?(/?)>');
  const openMatch = xml.match(openRe);
  if (!openMatch) return null;
  if (openMatch[1] === '/') return '';
  const afterOpen = xml.slice(openMatch.index + openMatch[0].length);
  const closeRe = new RegExp('</' + tagPattern + '>');
  const closeMatch = afterOpen.match(closeRe);
  if (!closeMatch) return null;
  const raw = afterOpen.slice(0, closeMatch.index);
  return String(raw)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'');
}

function partnerCredentials(keyPhase) {
  return `<PartnerCredentials xmlns="${NS}"><Name>${PARTNER_NAME}</Name>` +
    `<Token>${PARTNER_TOKEN}</Token><KeyPhase>${xmlEscape(keyPhase)}</KeyPhase></PartnerCredentials>`;
}

function deviceData() {
  return '<DeviceData>' +
    '<Version>1</Version>' +
    '<HardwareID>iobroker-parcel</HardwareID>' +
    '<BootSystemID>Android_Phone</BootSystemID>' +
    '<Name>ioBroker</Name>' +
    '<AppVersion>4.1.2</AppVersion>' +
    '<PushToken></PushToken>' +
    '<AllowPushNotifications>false</AllowPushNotifications>' +
  '</DeviceData>';
}

async function callSoap(requestClient, operation, body) {
  const envelope =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<soap:Body>' +
        `<${operation} xmlns="${NS}">${body}</${operation}>` +
      '</soap:Body>' +
    '</soap:Envelope>';
  const res = await requestClient({
    method: 'post',
    url: SERVICE_URL,
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: NS + operation,
      'User-Agent': 'ksoap2-android/2.6.0+',
      Accept: 'text/xml',
    },
    data: envelope,
    timeout: 60000,
  });
  const text = typeof res.data === 'string' ? res.data : String(res.data);
  return { status: res.status, text };
}

// ---------- public API ----------

/**
 * Zwei-Stufen-Login analog zur Android-App:
 *   1) getSessionFullState ohne SessionToken → anonymer Token
 *   2) getUserLogin mit anonymem SessionToken → User-SessionToken + cloudUserID
 *
 * @param {object} opts
 * @param {function} opts.requestClient - axios-like request function
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {object} [opts.log] - Logger mit .info/.debug/.error/.warn
 * @returns {Promise<{SessionToken: string, cloudUserID: number}|null>}
 */
async function loginDPD({ requestClient, username, password, log }) {
  if (!log) log = { info: console.log, debug: console.log, error: console.error, warn: console.warn };
  if (!username || !password) {
    log.error('[DPD/login] username/password fehlt.');
    return null;
  }

  // Stufe 1 — anonyme Session anfordern
  let anonSessionToken;
  try {
    const body =
      `<getSessionFullStateRequest xmlns="${NS}">` +
        `<Version>${API_VERSION}</Version><Language>${LANGUAGE}</Language>` +
        partnerCredentials(computeKeyPhase(0, 'getSessionFullState')) +
        '<SessionToken></SessionToken>' +
        deviceData() +
      '</getSessionFullStateRequest>';
    const res = await callSoap(requestClient, 'getSessionFullState', body);
    if (res.status !== 200) {
      log.error(`[DPD/anonSession] HTTP ${res.status}`);
      if (res.text) log.debug(`[DPD/anonSession] body: ${res.text.slice(0, 300)}`);
      return null;
    }
    anonSessionToken = pickXml(res.text, 'SessionToken');
    if (!anonSessionToken) {
      log.error('[DPD/anonSession] Kein SessionToken in Response — API-Antwort unerwartet.');
      log.debug(`[DPD/anonSession] body: ${(res.text || '').slice(0, 300)}`);
      return null;
    }
  } catch (err) {
    log.error('[DPD/anonSession] ' + (err && err.message));
    return null;
  }

  // Stufe 2 — User-Login
  try {
    const body =
      `<getUserLoginRequest xmlns="${NS}">` +
        `<Version>${API_VERSION}</Version><Language>${LANGUAGE}</Language>` +
        partnerCredentials(computeKeyPhase(0, 'getUserLogin')) +
        `<SessionToken>${xmlEscape(anonSessionToken)}</SessionToken>` +
        `<UserName>${xmlEscape(username)}</UserName>` +
        `<UserPassword>${xmlEscape(password)}</UserPassword>` +
      '</getUserLoginRequest>';
    const res = await callSoap(requestClient, 'getUserLogin', body);
    if (res.status !== 200) {
      log.error(`[DPD/login] getUserLogin HTTP ${res.status}`);
      if (res.text) log.debug(`[DPD/login] body: ${res.text.slice(0, 300)}`);
      return null;
    }
    const ack = pickXml(res.text, 'Ack');
    if (ack !== 'true') {
      const errorCode = pickXml(res.text, 'ErrorCode');
      const errorMsg = pickXml(res.text, 'ErrorMsg');
      log.error(`[DPD/login] abgelehnt: ${errorCode || '?'} – ${errorMsg || 'unbekannter Fehler'}`);
      return null;
    }
    const sessionToken = pickXml(res.text, 'SessionToken');
    const cloudUserID = Number.parseInt(pickXml(res.text, 'cloudUserID') || '0', 10);
    if (!sessionToken || !cloudUserID) {
      log.error('[DPD/login] SessionToken oder cloudUserID fehlt in Response.');
      log.debug(`[DPD/login] body: ${(res.text || '').slice(0, 300)}`);
      return null;
    }
    return { SessionToken: sessionToken, cloudUserID };
  } catch (err) {
    log.error('[DPD/login] ' + (err && err.message));
    return null;
  }
}

/**
 * Ruft `getSessionFullState` mit dem User-SessionToken auf und parst die drei
 * Tracking-Listen (Send/Receive/Return) in ein einheitliches sendungen[]-Format.
 *
 * Bei ungültiger Session (Ack=false) meldet die Funktion das über den Return-Wert
 * `{ status: 'invalid-session', ... }` — der Aufrufer entscheidet ob er neu
 * einloggt und den Fetch wiederholt.
 *
 * @param {object} opts
 * @param {function} opts.requestClient
 * @param {{SessionToken: string, cloudUserID: number}} opts.session
 * @param {object} [opts.log]
 * @returns {Promise<{status: 'ok', sessionToken: string|null, data: {sendungen: []}} |
 *                   {status: 'invalid-session', errorCode: string|null} |
 *                   {status: 'error', message: string} | null>}
 */
async function fetchDPDParcels({ requestClient, session, log }) {
  if (!log) log = { info: console.log, debug: console.log, error: console.error, warn: console.warn };
  if (!session || !session.SessionToken) return null;

  const body =
    `<getSessionFullStateRequest xmlns="${NS}">` +
      `<Version>${API_VERSION}</Version><Language>${LANGUAGE}</Language>` +
      partnerCredentials(computeKeyPhase(session.cloudUserID, 'getSessionFullState')) +
      `<SessionToken>${xmlEscape(session.SessionToken)}</SessionToken>` +
      deviceData() +
    '</getSessionFullStateRequest>';
  let res;
  try {
    res = await callSoap(requestClient, 'getSessionFullState', body);
  } catch (err) {
    log.error('[DPD/fetch] ' + (err && err.message));
    return { status: 'error', message: err && err.message };
  }
  if (res.status !== 200) {
    log.error(`[DPD/fetch] getSessionFullState HTTP ${res.status}`);
    if (res.text) log.debug(`[DPD/fetch] body: ${res.text.slice(0, 300)}`);
    return { status: 'error', message: 'HTTP ' + res.status };
  }
  const ack = pickXml(res.text, 'Ack');
  if (ack !== 'true') {
    const errorCode = pickXml(res.text, 'ErrorCode');
    return { status: 'invalid-session', errorCode };
  }
  const newToken = pickXml(res.text, 'SessionToken');
  return {
    status: 'ok',
    sessionToken: newToken && newToken !== session.SessionToken ? newToken : null,
    data: parseTrackingLists(res.text),
  };
}

/**
 * Extrahiert Sendungen aus den drei Listen im SessionFullState-Response.
 *
 *   ReceiveTrackingDataList / ReceiveTrackingData  → Empfangs-Sendungen
 *   SendTrackingDataList    / SendTrackingData     → gesendete Sendungen
 *   ReturnTrackingDataList  / ReturnTrackingData   → Retouren
 *
 * Server liefert leere Listen als self-closing (`<SendTrackingDataList />`) —
 * die Regex tolerieren das.
 */
function parseTrackingLists(xml) {
  const sendungen = [];
  const lists = [
    { listTag: 'SendTrackingDataList', itemTag: 'SendTrackingData', direction: 'send' },
    { listTag: 'ReceiveTrackingDataList', itemTag: 'ReceiveTrackingData', direction: 'receive' },
    { listTag: 'ReturnTrackingDataList', itemTag: 'ReturnTrackingData', direction: 'return' },
  ];
  const nsPrefix = '(?:[a-zA-Z_][\\w.-]*:)?';
  for (const { listTag, itemTag, direction } of lists) {
    const listOpenRe = new RegExp('<' + nsPrefix + listTag + '(?:\\s[^>]*?)?(/?)>');
    const openMatch = xml.match(listOpenRe);
    if (!openMatch) continue;
    if (openMatch[1] === '/') continue;
    const bodyRe = new RegExp('<' + nsPrefix + listTag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + nsPrefix + listTag + '>');
    const bodyMatch = xml.match(bodyRe);
    if (!bodyMatch) continue;
    const inner = bodyMatch[1];
    const itemRe = new RegExp('<' + nsPrefix + itemTag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + nsPrefix + itemTag + '>', 'g');
    let m;
    while ((m = itemRe.exec(inner)) !== null) {
      const item = m[1];
      const parcelNo = pickXml(item, 'ParcelNo');
      if (!parcelNo) continue;
      const lastStatusInfo = pickXml(item, 'LastStatusInfo') || '';
      sendungen.push({
        id: parcelNo,
        name: pickXml(item, 'ParcelNicName') || parcelNo,
        status: pickXml(lastStatusInfo, 'StatusText_Mobile') ||
                pickXml(item, 'StatusText_Mobile') ||
                pickXml(item, 'DataViewStatus') || '',
        statusId: pickXml(lastStatusInfo, 'StatusID') || pickXml(item, 'StatusID') || '',
        statusDate: pickXml(lastStatusInfo, 'StatusDate') || pickXml(item, 'StatusDate') || '',
        delivered: pickXml(item, 'Delivered') === 'true',
        eta: pickXml(item, 'EstimatedDeliveryDateTimeFrom') || '',
        direction,
        source: 'DPD',
      });
    }
  }
  return { sendungen };
}

module.exports = {
  loginDPD,
  fetchDPDParcels,
  parseTrackingLists,
  // exposed für ggf. externe Detail-Calls / Tests
  computeKeyPhase,
  pickXml,
  xmlEscape,
};
