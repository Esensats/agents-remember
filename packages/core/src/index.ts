/**
 * Public surface of the host-agnostic memory engine.
 *
 * Nothing in this package imports a coding-agent SDK. Adapters (Pi, DSH, or any
 * future host) supply a working directory, a store directory name, and a global
 * directory; everything else — parsing, identity, search, snapshots, recovery,
 * migration — lives here.
 */
export * from "./store.ts";
export * from "./notes.ts";
export * from "./search.ts";
export * from "./inject.ts";
export * from "./workspace.ts";
export * from "./migration.ts";

// `store.ts` re-exports NoteMetadata for its own API; name it once explicitly so
// the two star exports cannot shadow each other.
export type { NoteMetadata } from "./notes.ts";
