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

## 三、完整实现所需工作

1. **明确受保护的通信对象**：区分 CrossGram 原生 E2EE 联系人与 QQ/Discord/Matrix 外部桥接联系人。普通外部适配器不可能让其不支持此协议的终端自动解密；若桥接端解密，必须显式提示信任边界。
2. **选择成熟协议**：对 Telegram 原生设备间聊天优先评估 Secret Chat 全套协议；对自研原生多设备消息优先考虑经过审计的 Double Ratchet、MLS 或成熟客户端库，而非扩展此演示型密文信封。
3. **身份校验与设备管理**：平台账号和设备公钥认证绑定，安全码二维码核对，密钥变更警告，设备撤销，防止服务端对不同设备提供不一致的公钥视图。
4. **服务端密文路由**：设计独立于外部平台的原生收件人及设备模型，维护离线密文队列、单次消费、重试、幂等、持久化。不能把普通 QQ/Discord 联系人误认成具有 E2EE 私钥的设备。
5. **桌面及 Android 客户端接入**：在消息进入 MTProto/网络前加密，在设备内解密；处理 UI、安全码、解密失败状态、回复/搜索/通知预览，并关闭会导致明文泄露的云端特性。
6. **高级功能与安全性**：异步会话建立及预密钥、Double Ratchet 恢复能力、加密媒体分块、多设备同步、群成员变更重新密钥协商、密钥备份和透明迁移。
7. **测试与发布门槛**：两端独立进程真实消息流、恶意服务器篡改和重放、断网同步、SQLite/PostgreSQL 重启场景、客户端兼容矩阵及独立密码审计。

## 四、测试

```sh
yarn vitest run packages/e2ee/src/envelope.test.ts
yarn vitest run --config vitest.mtproto-e2e.config.mts packages/e2ee/src/envelope.e2e.test.ts
yarn typecheck
```

上述测试只验证原型的加密封装与不可信密文中继模拟，并**不**验证完整 Telegram/Messages 客户端端到端通信。
