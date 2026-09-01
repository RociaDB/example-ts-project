/**
 * The file service: invoice attachments and stock exports.
 *
 * Three ways to upload, from most to least help:
 *
 * | Method | Does for you | Use when |
 * |---|---|---|
 * | `uploadFile` | chunks, hashes, checks the size | the file is in memory |
 * | `uploadFileStream` | re-chunks a source, checks the declared total | the source is a stream and you know size and hash up front |
 * | `uploadFileRaw` | nothing | you build every message yourself |
 *
 * **Do not port these by name from the Rust SDK.** The middle tier is
 * `uploadFileStream` here and `upload_file_chunked` there; the raw escape
 * hatch is `uploadFileRaw` here and `upload_file_stream` there. The two names
 * that look alike are the two that are *not* each other's counterpart.
 *
 * The wire contract the first two honour for you: the **first** message
 * carries the metadata (tenant, bucket, file id, `sizeBytes`, `contentType`,
 * `checksum`, `requestId`); later messages are read only for their `chunk`;
 * no chunk may exceed 1 MiB; the chunks must add up to `sizeBytes` exactly;
 * and `checksum` must be exactly 32 bytes — the server checks its length,
 * never its content.
 */

import { createHash } from "node:crypto";
import type { FileMetadata, RawUploadMessage } from "@rocia/rociadb-sdk";
import { BUCKET, type Erp } from "./erp.js";

/** One 1 MiB message is the most the server accepts, and all the raw path here sends. */
const MAX_CHUNK_BYTES = 1024 * 1024;

/** The pieces `uploadStreamed` produces, to show the SDK re-buffering them. */
const SOURCE_PIECE_BYTES = 64 * 1024;

/**
 * Upload a file already in memory.
 *
 * With `checksum` omitted, `uploadFile` hashes the buffer itself and slices it
 * into 1 MiB messages. We pass it explicitly here to show the rule: it must be
 * exactly 32 bytes, or the call fails client-side before sending.
 */
export async function upload(
  erp: Erp,
  fileId: string,
  content: Uint8Array,
  contentType: string,
): Promise<void> {
  await erp.client.uploadFile(erp.tenant, BUCKET, fileId, content, {
    contentType,
    checksum: sha256(content),
    requestId: erp.key(`upload:${fileId}`),
  });
}

/**
 * Upload content produced in pieces, without holding all of it at once.
 *
 * `sizeBytes` and `checksum` travel on the very first gRPC message, before a
 * single byte has been read from the source, so both must be known up front —
 * that is the one thing `uploadFile` can do for you and this cannot. If the
 * source ends up producing a different total, the upload fails rather than
 * storing a file whose recorded size is a lie.
 *
 * The pieces here are 64 KiB; `uploadFileStream` re-buffers them into 1 MiB
 * messages whatever size they arrive in.
 */
export async function uploadStreamed(
  erp: Erp,
  fileId: string,
  content: Uint8Array,
  contentType: string,
): Promise<void> {
  await erp.client.uploadFileStream(
    {
      tenantId: erp.tenant,
      bucket: BUCKET,
      fileId,
      // A `bigint`: a file size is a protobuf `uint64` on the wire, and the
      // SDK refuses to narrow it to a `number` on your behalf.
      sizeBytes: BigInt(content.byteLength),
      contentType,
      checksum: sha256(content),
      requestId: erp.key(`export:${fileId}`),
    },
    pieces(content, SOURCE_PIECE_BYTES),
  );
}

/**
 * Upload by building the protobuf message yourself.
 *
 * `uploadFileRaw` is the low-level escape hatch: no re-chunking, no size cap
 * applied, no checksum computed, and no first-message/later-message
 * distinction. A wrong `sizeBytes`, or a checksum that does not match the
 * bytes, goes through silently — the server only checks the checksum's
 * length. This note fits in one message, which is the only case worth
 * hand-writing.
 */
export async function uploadRaw(erp: Erp, fileId: string, content: Uint8Array): Promise<void> {
  if (content.byteLength > MAX_CHUNK_BYTES) {
    throw new Error("uploadRaw only handles content that fits in one 1 MiB message");
  }

  const message: RawUploadMessage = {
    tenantId: erp.tenant,
    bucket: BUCKET,
    fileId,
    sizeBytes: BigInt(content.byteLength),
    contentType: "text/plain",
    checksum: sha256(content),
    chunk: content,
    requestId: erp.key(`raw:${fileId}`),
  };

  await erp.client.uploadFileRaw([message]);
}

/** Metadata without downloading the file. */
export function stat(erp: Erp, fileId: string): Promise<FileMetadata> {
  return erp.client.statFile(erp.tenant, BUCKET, fileId);
}

/** Download the whole file. */
export function download(erp: Erp, fileId: string): Promise<Uint8Array> {
  return erp.client.downloadFile(erp.tenant, BUCKET, fileId);
}

/**
 * Download as a stream, never holding the whole file in memory.
 *
 * Counting bytes here, but this is the same loop you would write to pipe it
 * to a file. Leaving the loop early cancels the gRPC call instead of letting
 * it run to the end, so an early `break` costs nothing.
 */
export async function downloadStreamed(erp: Erp, fileId: string): Promise<number> {
  let bytes = 0;
  for await (const chunk of erp.client.downloadFileStream(erp.tenant, BUCKET, fileId)) {
    bytes += chunk.byteLength;
  }
  return bytes;
}

/** The buckets in this tenant. */
export async function listBuckets(erp: Erp): Promise<string[]> {
  const page = await erp.client.listBuckets(erp.tenant, { limit: 50 });
  return page.items;
}

/** The files in our bucket. */
export async function listFiles(erp: Erp): Promise<string[]> {
  const files: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await erp.client.listFiles(erp.tenant, BUCKET, { limit: 50, cursor });
    files.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return files;
}

/** Delete a file. Idempotent, like `deleteDocument`. */
export async function remove(erp: Erp, fileId: string): Promise<void> {
  await erp.client.deleteFile(erp.tenant, BUCKET, fileId);
}

/** Delete a file with a chosen key. */
export async function removeWithKey(erp: Erp, fileId: string): Promise<void> {
  await erp.client.deleteFile(erp.tenant, BUCKET, fileId, erp.key(`delete-file:${fileId}`));
}

/** The 32-byte digest the server insists on. Any other length is refused. */
function sha256(content: Uint8Array): Uint8Array {
  return createHash("sha256").update(content).digest();
}

/** Cut a buffer into pieces, standing in for a source read in chunks. */
function* pieces(content: Uint8Array, size: number): Generator<Uint8Array> {
  for (let offset = 0; offset < content.byteLength; offset += size) {
    yield content.subarray(offset, Math.min(offset + size, content.byteLength));
  }
}
