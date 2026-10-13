# WebUI native protobuf transport

The `protobuf-native-v2` transport encodes both client commands and server
snapshots, deltas and RPC responses as typed protobuf Value/Struct/List fields.
It no longer serializes those bodies as JSON text inside a protobuf envelope.
The schema is `packages/cordis-webui-solidjs/src/webui.proto` and the codec has
no runtime protobuf dependency. Dynamic extension data remains supported.

The initial JSON bootstrap advertises the transport. Clients supporting v2
negotiate an upgrade before sending binary frames. Legacy JSON clients continue
using JSON; v1 clients do not automatically decode v2 binary frames. Server and
browser bundles should be deployed together. Gzip remains optional for large
frames and bounded decompression remains enforced.

The codec limits value size and recursion, rejects malformed UTF-8, lengths,
unsupported wire types and cycles, and prevents prototype setter invocation.
Undefined object values are omitted; array holes and nonfinite numbers become
null, preserving the former JSON boundary. Numbers remain JS double precision.

Tests cover field tags, nested values, malformed input, compression, client
negotiation, and a bidirectional RPC over a real upgraded WebSocket. Browser
E2E tests cover reconnect and production UI flows. This change removes JSON
parsing/stringification from upgraded message bodies; it does not establish a
measured CPU, allocation or bandwidth improvement for every workload.
