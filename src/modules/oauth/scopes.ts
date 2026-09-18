/**
 * Read-only. The bot lists and fetches Asher's videos and does nothing else to
 * them — a wider scope would let a mistake here move or delete his footage, and
 * there is no longer any write to justify asking for one.
 */
export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly", "openid", "email"];

/** A service account signs its own tokens, so it has no identity scopes to ask for. */
export const SERVICE_ACCOUNT_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];
