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

JSON / UTF-8，错误统一为 `{"error":"message"}`：400 参数无效，403 编辑密钥错误，404 不存在，413 过大。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/trips?q=&page=` | 最新优先，每页 12 条；`q` 模糊匹配标题/目的地/作者。返回 `{trips:[{id,title,destination,author,summary,dayCount,budgetTotal,coverPhotoId,createdAt}],page,hasMore}` |
| GET | `/api/trips/:id` | `{id,title,destination,author,summary,transport,lodging,tips,days:[{title,spots:[{name,note,lat,lng}]}],budget:[{label,amount}],photoIds,createdAt,updatedAt}`（不含编辑密钥） |
| POST | `/api/trips` | 请求体 `{title,destination,author,summary,transport,lodging,tips,days,budget,photoIds}`；`title` 必填（≤100），最多 60 天、每天 30 个景点、50 条预算、20 张照片，`amount` 为非负数。景点可选带位置 `lat`（-90..90）、`lng`（-180..180），须同时给出数字或同时缺省/为 null（否则 400）；无位置时读回为 null；`spots` 数组顺序即游览顺序和路线顺序。返回 201 与完整行程及 `editKey`（仅此一次） |
| PUT | `/api/trips/:id` | 同上请求体，需请求头 `X-Edit-Key`，否则 403；返回完整行程 |
| DELETE | `/api/trips/:id` | 需 `X-Edit-Key`；同时删除其照片；返回 `{ok:true}` |
| POST | `/api/photos` | 请求体为图片原始字节，`Content-Type` 为 `image/jpeg`、`image/png` 或 `image/webp`，最大 3 MB（类型错误 400，过大 413）。返回 201 `{id}` |
| GET | `/api/photos/:id` | 返回图片字节，带对应 `Content-Type` 与 `Cache-Control: public, max-age=86400` |
