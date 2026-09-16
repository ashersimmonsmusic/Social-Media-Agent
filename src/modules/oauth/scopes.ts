/**
 * Read-only. The bot needs to list and fetch Asher's videos and nothing more —
 * a wider scope would let a mistake here delete his footage.
 *
 * Lives apart from google.service.ts so the service-account path can share it
 * without importing the user-consent flow it doesn't use.
 */
export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly", "openid", "email"];

/** A service account signs its own tokens, so it has no identity scopes to ask for. */
export const SERVICE_ACCOUNT_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];
