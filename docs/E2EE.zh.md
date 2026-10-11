# CrossGram 端到端加密：实验性基础组件（尚未启用）

> **安全声明**：这不是已经投入使用的 Secret Chat，更不是当前 CrossGram 中 QQ、Discord、Matrix 消息的端到端加密。客户端没有接入此模块，不能宣称产品具有 E2EE。

## 一、为什么 MTProto 加密不等于 E2EE

CrossGram 是桥接到 QQ、Matrix、Discord 等平台的 Telegram **服务器端**。现有 MTProto 握手产生的是「Telegram 客户端 ↔ CrossGram 服务端」之间的传输加密。Bridge 从服务端接收明文并交给平台适配器，因此服务端可以看到消息内容。

Telegram Secret Chat 所需的 `messages.requestEncryption`、`messages.acceptEncryption`、`messages.sendEncrypted` 等构造器虽已包含在 TL Schema 中，但没有配套的 RPC、会话密钥协商、持久密文队列和接收端处理。部分客户端本身支持 Telegram Secret Chat，并不意味着 CrossGram 服务端已支持。

**重要区别**：如果只在 CrossGram 的 Matrix 适配器中解密 Olm/Megolm，CrossGram 服务端会成为 Matrix 端到端加密的一个终点，不能算 Telegram 设备与 Matrix 联系人设备之间的真正 E2EE。QQ 和 Discord 平台的普通接收端也不具备解开 CrossGram 自定义密文的能力。

## 二、本分支已实现的实验性原型

代码位于 `packages/e2ee/src/envelope.ts`，意图由原生客户端调用，服务端只能搬运该密文结构。

- 终端各自创建 Ed25519 签名私钥与 X25519 协商私钥；两者**不得**上传到 CrossGram 服务端。
- 使用独立渠道认证收件人设备公钥（如扫描二维码核对安全码），不能盲信服务器发布的公钥。
- 每条消息使用新的一次性 X25519 私钥、随机盐及随机 nonce，派生 AES-256-GCM 密钥；发送人 Ed25519 签署完整密文信封。
- AAD 绑定聊天 ID、发信设备 ID、收信设备 ID 及接收方 X25519 公钥指纹。
- 接收端先验证发送人被认证的签名公钥，再验证 AEAD 密文；要求外部提供**原子且持久**的重放防护。
- 多设备收信时，必须针对每一个已验证设备分别加密并发送独立信封；不能默认信任新增设备。
- 不改变原有桥接消息处理；默认不启用该模块。

使用的是 Node.js `node:crypto` 对 X25519、Ed25519、HKDF-SHA-256、AES-256-GCM 的实现，并未自行编写底层密码算法。

### 尚不具备的安全属性

这只是密文信封与身份认证的概念验证，**没有 Signal Double Ratchet、MLS、Telegram Secret Chat 或 Matrix Olm/Megolm 的兼容能力**。缺少预密钥分发、离线会话建立、密钥透明度、设备撤销、附件加密、群聊密钥更新、备份恢复和端到端身份验证 UI。接收端长期 X25519 密钥一旦被窃取，可用它解密已录制的历史信封；发送人的临时 X25519 密钥并**不意味着完整前向保密性**，也没有被攻陷后的自动恢复能力。

`MemoryReplayGuard` **只能用于测试**，因为重启后会丢失重放记录；生产应以数据库事务或相当的原子操作持久化已消费 ID。

此原型不应直接作为生产端到端加密系统部署，需要专业安全审查，并优先评估成熟的会话层密码协议。

## 三、设备身份、密文接收与持久重放原型（新增）

新增 `packages/e2ee/src/devices.ts`：

- `exportDeviceBundle` / `parseDeviceBundle`：序列化并严格校验公开的 Ed25519、X25519 SPKI 密钥，公钥包不包含私钥。
- `bundleFingerprint` / `verifyAndPinDevice`：要求用户通过**服务器之外的独立认证渠道**核对 SHA-256 公钥指纹；只有核对成功，才会原子性地固定至本地设备存储；同一账号、设备 ID 出现新的公钥时拒绝静默替换。
- `getPinnedDevice` / `openFromPinnedDevice`：接收端仅允许已经独立核验并固定的发信设备；被撤销或未知设备一律拒绝，不能按服务器传来的公钥自动解密。
- `sealToPinnedDevices`：先核验所有收件设备均已受信，才对每个收件设备独立加密；禁止空收件人、重复 ID、超过 32 台设备的无界扩散。
- `DevicePinStore` 接口：实际客户端必须提供本地、持久、**不可被服务端覆盖**的原子固定实现。现有 `MemoryDevicePinStore` **仅供测试**，重启后不能继续保护换钥检测。

新增 `packages/e2ee/src/replay-ledger.ts`：

- `PosixFileReplayGuard` 提供通过 `O_EXCL` 及文件/目录 `fsync` 的持久防重放演示；可拒绝进程重启后的同一条密文，并通过原子创建操作阻止多个进程同时消费相同的消息。
- **只适用于 POSIX 实验环境，禁止用于生产服务端。** 根目录必须预先建立，归当前用户所有，权限至少应为 `0700`（不能授予组/其他用户权限），且必须使用能够持久化目录 `fsync` 的文件系统。
- 每条密文都会生成一个文件，不清理、不能扩容处理高吞吐消息。Windows 会明确拒绝，真实客户端应以加密 SQLite/本地 KV 的原子事务替换它。
- 重放库不可自行删除、恢复至旧快照；恢复旧备份等于失去历史防重放保证，生产方案需与消息状态一起防回滚。

**注意**：设备身份验证不是服务端 API 返回的 `fingerprint` 字符串比对。客户端必须在 QR 核验、人际联系等独立可信渠道上取得指纹；如果比较值和公钥都来自同一个恶意服务器，攻击者可以同时替换二者。根目录的建立与保护必须由客户端执行，CrossGram 服务端不得生成或管理客户端私钥、设备信任数据。

### 此轮新增的测试

```sh
yarn vitest run packages/e2ee/src/devices.test.ts
yarn vitest run packages/e2ee/src/replay-ledger.test.ts
```

以上测试是本地密码学原型测试，尚未在 GitHub CI 上获得通过记录，尚未接入任何真实 Telegram 客户端。

## 四、加密投递与离线持久化原型（新增）

新增 `packages/e2ee/src/mailbox.ts` 与 `packages/e2ee/src/sqlite-mailbox.ts`，供**服务器端传输层**使用；它们只保存客户端产生的密文信封和必要的路由元信息，不接受客户端私钥，也不执行客户端消息解密。

- `MemoryEncryptedMailbox`：内存队列、每设备最多 100 条、重复提交去重、消息过期、设备隔离和 ACK；**仅用于模拟测试**。
- `SqliteEncryptedMailbox`：通过 `node:sqlite` 事务将密文信封、账号/设备 ID、时间戳、保留期、去重墓碑写入 SQLite；采用 `BEGIN IMMEDIATE`、WAL（磁盘库）与 `synchronous=FULL`。重启后仍可拉取未确认密文，且确认消费后仍保留去重墓碑至其 TTL。默认保留期 7 天，每设备最多 100 条。
- 任何投递都必须传入**可信服务端上下文**生成的发送账号/设备身份，并提供独立的 ACL 回调，核查接收设备归属、会话成员权限及服务器上的身份绑定。不能直接从 HTTP/MTProto 请求体提取这两项并宣称已认证。
- 收取与 ACK 同样必须由服务器把实际登录会话解析为收信账号+设备；SDK 的 TypeScript `AuthenticatedDevice` 接口**本身不是认证凭据**。
- 收件方必须在端上验证发送者身份、公钥、AEAD 和本地重放记录成功后，才向服务端发送 ACK；对密文的 JSON 完整性及签名验证不能托付给服务端。

**重要局限**：两个邮箱实现均尚未接入 CrossGram Bridge、真实的 MTProto/HTTP RPC 或客户端，也没有部署认证接口。SQLite 后端是单机持久化原型，尚未实现水平扩展、完整限速、设备目录与账号绑定、正式的消息恢复/确认协议、数据库密文备份策略、存储加密、基于端到端密码状态的同步安全性。服务器仍可观察账号、聊天标识、设备、长度和时间，且能够丢弃、重排或延迟消息。服务器即使无法解密，也不代表消息获得完整的前向保密或入侵后恢复。

**桥接安全边界没有改变**：这些原型仅可用于双方终端支持此协议的 CrossGram 原生收件设备；不能透明地将 QQ/Discord 等平台的普通聊天改造成端到端加密。

### 新增测试指令

```sh
yarn vitest run packages/e2ee/src/mailbox.e2e.test.ts --config vitest.mtproto-e2e.config.mts
yarn vitest run packages/e2ee/src/sqlite-mailbox.test.ts packages/e2ee/src/sqlite-pins.test.ts
```

仅覆盖模拟原生设备及本地 SQLite 生命周期，不构成上线测试或安全审计。

## 五、账号绑定加密信封 v2 与本地信任持久化

**协议变更（Breaking）**：实验性信封由 `v: 1` 升为 `v: 2`。每条密文现在显式包含并加密认证 `senderAccountId`、`recipientAccountId`。两个账号 ID 同时参与 Ed25519 签名消息、AES-GCM AAD、HKDF 信息派生。旧 v1 信封默认拒绝；**本项目还没有生产密文迁移需求，也没有启用的 E2EE 会话**。

- 客户端调用 `sealMessage(plaintext, conversationId, senderIdentity, recipientDevice, { senderAccountId, recipientAccountId })` 时，必须使用**本地已经验证**的账号身份，而不能简单相信服务器提供的 `senderAccountId`。
- 接收端 `openMessage(..., replayGuard, { senderAccountId, recipientAccountId })` 必须用本地已知的收件账号、已验证的对方账号与会话信息匹配；若字段不符，即使密文原本有效也拒绝。
- 服务器 `MemoryEncryptedMailbox` 和 `SqliteEncryptedMailbox` 只接受账号与设备 ID 同时匹配**可信授权上下文**的信封，阻止跨账号重新标记消息。**此处的类型不是认证本身，实际认证接入仍未实现**。
- 原始 `bundleFingerprint(bundle)` 只计算设备密钥指纹。供用户核对的绑定安全码改为 `accountDeviceFingerprint(accountId, bundle)`，包含账号 ID 与设备公钥指纹；`verifyAndPinDevice` 只接受**绑定账号的**安全码，并拒绝旧裸公钥指纹。
- 为客户端新增 `SqliteDevicePinStore`，通过 `@mtproto-relay/e2ee/local-pins` 导入。它使用 SQLite 的原子 `INSERT OR IGNORE`、WAL、`synchronous=FULL`，防止并发静默覆盖经过验证的设备公钥。设备 pin 在进程重启后仍存在，换钥必须经过明确撤销与再次人工验证。
- 本地 pin 的磁盘根目录必须由客户端先建立，所属用户正确、无组/其他权限（通常 `0700`），SQLite 文件须为当前用户独占（通常 `0600`），拒绝符号链接或存在其他硬链接的数据库。Windows 的磁盘版原型暂时 fail closed；支持内存测试。客户端正式实现还需要操作系统密钥库、数据库加密、备份与回滚防护。

新增覆盖：账号 relabeling/换钥攻击、v1 降级拒绝、绑定安全码跨账号混淆、SQLite 信任记录跨重启保留、独立连接并发争抢同一设备 pin，以及不安全目录/文件拒绝。

```sh
yarn vitest run packages/e2ee/src/sqlite-pins.test.ts
```

**安全限定**：v2 仍然是原型自定义信封，不具备 Double Ratchet/MLS 的正式会话安全性；不能用来宣称当前 Telegram / QQ / Discord / Matrix 聊天已获得真正的 E2EE。

## 六、完整实现所需工作

1. **明确受保护的通信对象**：区分 CrossGram 原生 E2EE 联系人与 QQ/Discord/Matrix 外部桥接联系人。普通外部适配器不可能让其不支持此协议的终端自动解密；若桥接端解密，必须显式提示信任边界。
2. **选择成熟协议**：对 Telegram 原生设备间聊天优先评估 Secret Chat 全套协议；对自研原生多设备消息优先考虑经过审计的 Double Ratchet、MLS 或成熟客户端库，而非扩展此演示型密文信封。
3. **身份校验与设备管理**：平台账号和设备公钥认证绑定，安全码二维码核对，密钥变更警告，设备撤销，防止服务端对不同设备提供不一致的公钥视图。
4. **服务端密文路由**：设计独立于外部平台的原生收件人及设备模型，维护离线密文队列、单次消费、重试、幂等、持久化。不能把普通 QQ/Discord 联系人误认成具有 E2EE 私钥的设备。
5. **桌面及 Android 客户端接入**：在消息进入 MTProto/网络前加密，在设备内解密；处理 UI、安全码、解密失败状态、回复/搜索/通知预览，并关闭会导致明文泄露的云端特性。
6. **高级功能与安全性**：异步会话建立及预密钥、Double Ratchet 恢复能力、加密媒体分块、多设备同步、群成员变更重新密钥协商、密钥备份和透明迁移。
7. **测试与发布门槛**：两端独立进程真实消息流、恶意服务器篡改和重放、断网同步、SQLite/PostgreSQL 重启场景、客户端兼容矩阵及独立密码审计。

## 七、测试

```sh
yarn vitest run packages/e2ee/src/envelope.test.ts packages/e2ee/src/devices.test.ts packages/e2ee/src/replay-ledger.test.ts packages/e2ee/src/sqlite-mailbox.test.ts
yarn vitest run --config vitest.mtproto-e2e.config.mts packages/e2ee/src/envelope.e2e.test.ts packages/e2ee/src/mailbox.e2e.test.ts
yarn typecheck
```

上述测试只验证原型的加密封装与不可信密文中继模拟，并**不**验证完整 Telegram/Messages 客户端端到端通信。
