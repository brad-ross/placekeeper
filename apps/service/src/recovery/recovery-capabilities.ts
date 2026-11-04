/** The snapshot parser and build metadata share this declaration. A retained
 * desktop reader is selected by exact bundle bytes, never an app version. */
export const RECOVERY_CAPABILITIES = {
  readableDraftSchemaVersions: [1, 2, 3],
  writtenDraftSchemaVersion: 3,
} as const;
