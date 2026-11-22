# pm-4-travel-route-share
ProjectMind: 旅游路线分享

## 运行

需要 Node.js 22.13 或更高版本（使用内置 `node:sqlite`，无需 npm 依赖）。

```
npm start        # 等同于 node server.js，默认监听 3000 端口
npm test         # node --test，测试使用临时数据库
```

环境变量：`PORT`（默认 3000）、`DATABASE_FILE`（默认 `data/app.db`，`data/` 启动时自动创建且已被 git 忽略）。
首次启动且行程表为空时会写入 3 条中文示例行程。`public/` 下的静态文件由同一服务提供（`/` 返回 `public/index.html`）。

## API

JSON / UTF-8，错误统一为 `{"error":"message"}`：400 参数无效，401 未登录，403 无权修改，404 不存在，409 邮箱已注册，413 过大，429 请求太频繁。

账号规则：邮箱 + 密码登录。所有 GET 接口公开；发布行程、上传照片需登录，编辑/删除行程需本人登录。登录凭证放在请求头 `Authorization: Bearer <token>`，token 有效期 30 天（库中只保存其 sha256，密码用 scrypt + 随机 salt 存储）。行程作者自动取自登录用户的昵称（请求体里的 `author` 被忽略，昵称不可修改）。旧行程（`userId` 为 null）保留原作者名，仍用请求头 `X-Edit-Key` 编辑/删除。注册与登录按 IP 限流，每分钟最多 20 次。数据库版本由 `PRAGMA user_version` 管理（当前 2）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 请求体 `{email,password,displayName}`：email 合法且 ≤120（存储时转小写），password 8~72 位，displayName 1~50 字。返回 201 `{token,user:{id,email,displayName}}`；邮箱已注册 409；字段不合法 400 |
| POST | `/api/auth/login` | 请求体 `{email,password}`；返回 200 `{token,user}`；邮箱或密码错误统一 401 `邮箱或密码不对` |
| GET | `/api/auth/me` | 需登录；返回 `{user:{id,email,displayName}}`，未登录 401 |
| POST | `/api/auth/logout` | 需登录；删除当前会话，返回 `{ok:true}` |
| GET | `/api/trips?q=&page=` | 最新优先，每页 12 条；`q` 模糊匹配标题/目的地/作者（含用户昵称）。返回 `{trips:[{id,userId,title,destination,author,summary,dayCount,budgetTotal,coverPhotoId,createdAt}],page,hasMore}` |
| GET | `/api/trips/:id` | `{id,userId,title,destination,author,summary,transport,lodging,tips,days:[{title,spots:[{name,note,lat,lng}]}],budget:[{label,amount}],photoIds,createdAt,updatedAt}`（不含编辑密钥） |
| POST | `/api/trips` | 需登录（否则 401 `请先登录`）。请求体 `{title,destination,summary,transport,lodging,tips,days,budget,photoIds}`；`title` 必填（≤100），最多 60 天、每天 30 个景点、50 条预算、20 张照片，`amount` 为非负数。景点可选带位置 `lat`（-90..90）、`lng`（-180..180），须同时给出数字或同时缺省/为 null（否则 400）；无位置时读回为 null；`spots` 数组顺序即游览顺序和路线顺序。`author` 被忽略，行程写入当前用户 `user_id`。返回 201 与完整行程（`author` 为用户昵称，不再返回 `editKey`） |
| PUT | `/api/trips/:id` | 同上请求体（`author` 被忽略，不改变归属）。有归属的行程需作者本人登录（未登录 401，他人 403 `只有作者本人可以修改`）；旧行程需请求头 `X-Edit-Key`，否则 403；返回完整行程 |
| DELETE | `/api/trips/:id` | 权限同 PUT；同时删除其照片；返回 `{ok:true}` |
| POST | `/api/photos` | 需登录（否则 401）。请求体为图片原始字节，`Content-Type` 为 `image/jpeg`、`image/png` 或 `image/webp`，最大 3 MB（类型错误 400，过大 413）。返回 201 `{id}` |
| GET | `/api/photos/:id` | 返回图片字节，带对应 `Content-Type` 与 `Cache-Control: public, max-age=86400` |
