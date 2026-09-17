/**
 * What the bot may do in Drive.
 *
 * `drive.file` would be the narrow choice, but it only ever covers files the
 * app itself created — useless for footage Asher put there. Renaming an
 * existing file needs the broad scope, and Google offers nothing between the
 * two.
 *
 * So the limit is enforced in code instead: drive.service.ts exposes exactly one
 * write, which sets a file's name. There is no call anywhere that deletes,
 * moves, or changes a file's contents, and a rename is reversible from the
 * audit log, which keeps the previous name.
 */
export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive", "openid", "email"];

/** A service account signs its own tokens, so it has no identity scopes to ask for. */
export const SERVICE_ACCOUNT_SCOPES = ["https://www.googleapis.com/auth/drive"];
