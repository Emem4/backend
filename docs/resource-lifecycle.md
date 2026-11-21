# Resource backing-location lifecycle (#175)

A `resources` row is only valid when its `resource_type` agrees with where its
content actually lives. Postgres enforces this with the
`resources_backing_shape_valid` check constraint declared in
`src/db/schema.ts` and added in `drizzle/0027_resource_backing_invariants.sql`.

## Valid row shapes

| Shape | `resource_type` | `storage_path` | `external_url` | Meaning |
| --- | --- | --- | --- | --- |
| Staged file | `file` | `NULL` | `NULL` | Upload in progress. Valid only as a transition. |
| Finalized file | `file` | set | `NULL` | Content is an object in the configured storage bucket. |
| Link | `link` | `NULL` | set | Content lives at an external HTTP(S) URL. |

Anything else is impossible and is rejected by the database:

* a `file` row with `external_url` set (files are delivered from storage);
* a `link` row with `storage_path` set (links have no stored object);
* a row with both backing locations set;
* a `link` row with no backing location (links are never staged).

## Staged file uploads

`createFileResource()` in `src/services/resourceService.ts` performs the
transition in two steps:

1. Insert a **staged** row: `resource_type = 'file'`, both backing columns
   explicitly `NULL`. Quota is reserved and content metadata (`contentHash`,
   `mimeType`, `sizeBytes`) is recorded at this point, but no object exists yet.
2. Call `uploadFile()`. On success, set `storage_path`, which promotes the row
   to its **finalized file** shape. On failure the row is deleted and the quota
   reservation released, so a staged row is never left behind by the happy-path
   or failure-path code.

The `storage_path IS NULL` branch of the check exists solely for step 1. It
does not permit any other nullable-backing combination.

## Finalized rows

`createLinkResource()` inserts a link directly in its finalized shape:
`resource_type = 'link'`, `external_url` set, `storage_path` NULL. There is no
staged link state.

Both read paths rely on this invariant: `GET /resources/:id/content` chooses
between `external_url` and `storage_path` based on `resource_type`, so ambiguous
rows could previously be delivered incorrectly or not at all.

## Migration behaviour

The migration first reports legacy rows in impossible shapes, then normalizes
them without deleting data:

* a file with only `external_url` becomes a link;
* a file with both locations keeps its stored object and drops `external_url`;
* a link with only `storage_path` becomes a file;
* a link with both locations keeps its URL and drops `storage_path`;
* a link with neither location becomes a staged file.

The check constraint is added last, so all subsequent writes are validated.
