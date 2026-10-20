# B3A 下一班

CDT501 第 8 课的实时巴士到站网页。课堂页面要求制作 `bus.html`，显示从富泰邨往深圳湾口岸的 B3A 下一班巴士还有几分钟，使用 DATA.GOV.HK 的城巴开放数据，每 30 秒刷新。

## 使用

公开网页：[B3A 实时到站看板](https://yuchen030616-bot.github.io/b3a-bus-board/bus.html)。

打开 `dist/bus.html`，或用任意静态网页服务器提供 `dist/`。页面无需 API 密钥或后端。需要网络连接才能取得实时到站预测。

课堂要求来源：[Moodle — Lecture Slides and assets](https://lms.ln.edu.hk/mod/folder/view.php?id=982568)（需学校账号）。

## 数据

- 路线：城巴 CTB B3A。
- 站点：`003261`，富泰邨（青山公路）。
- 方向：`O`，往深圳湾口岸。
- ETA：<https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/003261/B3A>
- 官方数据集：<https://data.gov.hk/en-data/dataset/ctb-eta-transport-realtime-eta>

网页按照课堂要求每 30 秒请求一次。数据提供者自身的更新周期可能较长，因此连续刷新可能返回相同预测。到站时间仅供参考，以实际交通情况及城巴公告为准。

页面不收集学校账号、密码或个人信息，也不包含 Moodle 登录资料。语言偏好仅存储在使用者的浏览器中。

## 检查与发布

运行 `node --test tests/*.test.cjs` 检查到站时间计算、路线过滤、过期数据和缺失预测。推送到 `codex/b3a-bus-board` 分支后，GitHub Actions 会先运行检查，再将 `dist/` 发布至 GitHub Pages。
