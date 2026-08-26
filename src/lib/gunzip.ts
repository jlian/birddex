/**
 * Decompress a fetched asset, unless the transport already did it.
 *
 * Cloudflare serves the .gz asset as an opaque body, so the raw gzip arrives and
 * has to be decoded here. `wrangler dev` instead labels it `Content-Encoding:
 * gzip` off the file extension, so the browser decodes it in transit and this
 * receives the decompressed payload rather than the file. The gzip magic says
 * which happened, and it cannot collide: a decoded blob starts with its own
 * ASCII magic, "WDOP" or "WDRR".
 *
 * Lives in its own module so a page that only needs the 1.38 MiB rarity asset
 * does not import bird-id-local.ts and drag the ONNX runtime in with it.
 */
export async function gunzipIfNeeded(buf: Uint8Array): Promise<Uint8Array> {
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf
  const ds = new DecompressionStream("gzip")
  const writer = ds.writable.getWriter()
  void writer.write(buf)
  void writer.close()
  const out = await new Response(ds.readable).arrayBuffer()
  return new Uint8Array(out)
}
