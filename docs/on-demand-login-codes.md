# On-demand Telegram login codes / 按需生成验证码

CrossGram's bridge plugin defaults to **on-demand login codes**.

```yaml
- name: '@mtproto-relay/bridge'
  config:
    onDemandLoginCodes: true # default
```

You can also change **onDemandLoginCodes** in the bridge plugin settings in the
Cordis WebUI (enabled by default).

## Enabled (default)

- Account cards show a virtual phone number but **no code** until a Telegram
  client calls `auth.sendCode` or an authorized WebUI operator clicks **生成 /
  Generate code**.
- Issued codes remain constant for **five minutes**; refreshing the WebUI or
  reading account metadata does **not** rotate or generate them.
- `auth.resendCode` and the WebUI **Generate code** button replace the existing
  code; previously issued codes immediately become invalid.
- A successful code-based sign-in consumes the code. Expired codes are rejected
  even if a stale client page still shows them.
- Codes are kept only in server memory; a server restart invalidates them and
  clients need to request a new one.
- The six-digit value is visible only through existing protected account-management
  surfaces; TOTP secrets are never exposed. Protect your WebUI authentication.

## Disabled (legacy behavior)

Set `onDemandLoginCodes: false` to restore the previous RFC 6238 six-digit
TOTP code that changes every **30 seconds** without a client request. This
mode retains the existing WebUI countdown and authentication behavior.

## 中文说明

默认开启按需生成。客户端请求验证码时，服务端生成一次并推送到 WebUI
平台账号卡片；也可以点击“生成 / Generate code”手动更新。
验证码有效期五分钟，期间不会定时轮换。重新发送会使旧码失效，
成功使用一次后立即作废。关闭开关可恢复原来的 30 秒 TOTP 自动轮换模式。

> 此开关控制手机号验证码登录；二维码登录和二步验证密码的流程不受影响。
