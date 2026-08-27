import { createHash } from 'node:crypto'

import type { RavenSourceRepresentation, RavenSourceResource } from './domain.js'

/** Stable digest binding canonical Markdown and its provenance to one Original Resource. */
export function sourceInspectionSha256(
  resource: RavenSourceResource,
  representation: RavenSourceRepresentation,
): string {
  const canonical = JSON.stringify({
    resource: {
      origin: resource.origin,
      uri: resource.uri,
      mediaType: resource.mediaType ?? null,
      sourceName: resource.sourceName ?? null,
    },
    representation: {
      format: representation.format,
      derivation: representation.derivation,
      coverage: representation.coverage,
      producedBy: representation.producedBy,
      inspectionCallId: representation.inspectionCallId ?? null,
      markdown: representation.markdown ?? null,
    },
  })
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex')
}
