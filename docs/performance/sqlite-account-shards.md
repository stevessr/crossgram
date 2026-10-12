# CrossGram SQLite 账号分库与批量写入（第一阶段）

## 适用范围

update-store-database 插件现在支持可选的 MTProto 更新投递日志分库：按照 mtproto_platform_session.id（每个适配器账号实例的稳定 ID）创建独立的 SQLite WAL 文件与批量提交队列。

注意：目前**仅对 mtproto_update_delivery 更新日志分库**。账号身份、联系人、消息、媒体、全局数字 ID 和其余 Cordis 表仍在主库中。切勿直接手工拆分 mtproto_im_message 等互相引用的表。

## 配置示例

将以下配置合并到 app.yml 的 update-store-database 插件配置中：

```yaml
- id: update-store-database
  name: '@mtproto-relay/update-store-database'
  config:
    retention: 10000
    sqliteShards:
      enabled: true
      directory: ./data/update-shards
      batchWindowMs: 8
      maxBatchSize: 64
      busyTimeoutMs: 5000
      accounts:
        # 账号实例 ID 可以查询主库 mtproto_platform_session 表
        '<discord-account-session-id>':
          path: ./data/update-shards/discord-main.db
          batchWindowMs: 5
          maxBatchSize: 128
        '<qq-account-session-id>':
          path: ./data/update-shards/qq-main.db
          batchWindowMs: 20
          maxBatchSize: 32
```

未配置 path 的账号，其文件名由账号 session ID 的 SHA-256 哈希生成。账号文件内部保存不可变的 session ID：禁止两个账号复用一个路径。已有账号迁移文件路径必须先停机操作。

## 提交与隔离语义

- 每个账号单独维护 batchWindowMs 与 maxBatchSize。前者为聚合等待窗口（0～1000 毫秒），后者为触发提交的最大写操作数（1～1024）。默认 8ms / 64。
- 所有写入 API 返回的 Promise 都在对应账号的 SQLite COMMIT 成功后才完成，不提前确认尚在内存队列中的事件。批次内任一操作失败会回滚整个批次。
- 读取前强制排空相关账号的未提交队列，确保 read-your-writes。进程退出时关闭连接前也会提交队列。
- 每个文件单独使用 WAL、busy_timeout 与 synchronous=FULL，优先保证提交后掉电持久性；数据库文件可分别使用操作系统文件页缓存，且不会竞争同一 SQLite 写锁。
- 该实现仍使用 node:sqlite 的同步 DatabaseSync：账号之间消除了同文件写锁竞争，但还没有把 SQLite 操作派给 worker_threads，因此不要将其理解为 Node 主线程内的真正多核 SQL 并行。

## 升级与恢复

1. 停止服务，使用 SQLite 的备份 API 或 VACUUM INTO 取得主库及对应 WAL 的一致性备份，不要在数据库仍运行时只复制一个 .db 文件。
2. 停止服务时启用分库配置后再启动。第一次使用更新日志会以最多 128 条一页从旧 mtproto_update_delivery 表迁移。
3. 每页先写入新的账号文件并 COMMIT，再删除原表成功迁移的行。发生崩溃后同一事件键会用 INSERT OR IGNORE 重试，避免重复行。
4. 检查启动日志、各账号 getDifference、数据文件和容量后再长期运行。
5. **不能只把 enabled 改回 false 就回退**：新版本写入的新日志不会反向同步到旧主库。回退需离线反向迁移或恢复备份。

不要在同一主库上混合运行开启与关闭分库的 CrossGram 实例。

## 后续可拓展范围

消息与联系人全部分库需要先调整全局数字 ID 分配、历史查询路由、关系引用、跨账号汇总、跨文件事务、在线迁移和每账号 worker；此阶段不做风险较高的自动重写。
