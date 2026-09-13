# CloudBase 免费部署步骤

核对日期：2026-09-02

## 为什么只部署一个网站

学生端和辅导员工作台共用同一个 CloudBase 环境和数据库，只是访问地址不同：

- 学生：`网站地址/student/`
- 辅导员：`网站地址/admin/`

不需要部署两套网站，所有数据都存在腾讯云，学生用手机浏览器即可访问。

## 部署完成后你应该看到

环境 ID：`你的云开发环境ID`

正式入口：https://你的云开发环境ID-你的账号后缀.tcloudbaseapp.com/

环境里应有：7 张业务表、行级安全保护、数据库安全函数和一个静态网站；「身份认证」中开启匿名学生登录和辅导员用户名密码登录。网页直接调用数据库安全函数，数据库会从登录令牌读取真实用户 UID，不能靠修改前端参数冒充别人。

第一次用手机打开默认免费域名时，腾讯云会先显示“页面访问提示”，学生需要点击一次“确定访问”。这是 CloudBase 默认测试域名强制提供的提示，在 Cookie 有效期内通常不会重复出现；只有使用已备案的自定义域名才能移除。

CloudBase 当前公开价格页写明免费体验版为 0 元/月、每月 3000 资源点。一个年级四个班的正常填写量预计远低于此额度，但仍要在控制台查看实际用量，不能把“预计”当成保证。

## 重新部署或换环境

1. 打开腾讯云 CloudBase 控制台，创建“免费体验版”环境，地域选上海。
2. 复制环境 ID，不要复制 SecretId、SecretKey 或验证码给任何人。
3. 在“身份认证”中确认已开启“匿名登录”和“用户名密码登录”；在“静态网站托管”中完成首次开通（免费版包含额度，不开通无法上传网页）。
4. 创建辅导员账号，用户名建议 `counselor`，密码由你本人或辅导员现场设置；不要把密码写进网页代码。
5. 复制该辅导员账号的 UID。
6. 把 `.env.example` 复制为 `.env.local`，只填写环境 ID、地域、用户名和 UID。
7. **登录 CloudBase 命令行工具（全新电脑必做）**：

```powershell
npx cloudbase login
```

浏览器会弹出腾讯云授权页，确认后终端显示登录成功。之后随时可用 `npx cloudbase env list` 检查：能列出你的环境就说明已登录；报 "No valid identity information" 就是没登录。换电脑或重装系统后需要重新登录。

8. 在项目文件夹终端依次运行：

```powershell
npm install
node scripts/apply-database.mjs
node scripts/import-students.mjs data/students.csv
npm run build
node node_modules/@cloudbase/cli/bin/tcb hosting deploy dist / -e 你的环境ID
```

注意用完整的 `npm install`，不要加 `--omit=dev` 或 `--production`：建库、导入、部署脚本依赖的 CloudBase CLI 就在开发依赖里。

`apply-database.mjs` 会逐条创建或更新 PostgreSQL 数据表和安全函数，可重复运行；`import-students.mjs` 把学生名单导入数据库（见下节）；最后一条命令发布静态网站。网页通过数据库安全函数（RPC）完成全部业务，不依赖云函数；`cloudfunctions/dorm-api` 是预留的服务端入口，暂不部署也不影响使用。

## 学生名单

1. 按 `data/students-template.csv` 的表头整理名单（classId、className、classCode、studentId、name、gender），保存为 `data/students.csv`。系统会用班级、班号、姓名、学号四项核验学生身份，所以四项必须与名单完全一致。
2. 先试运行检查名单有没有问题（不连接云端、不写数据）：

```powershell
node scripts/import-students.mjs data/students.csv --dry-run
```

3. 确认输出的人数、男女分布正确后，去掉 `--dry-run` 正式导入。

导入规则：

- 学号是唯一标识，重复学号会报错阻止导入；已导入过的学号再次执行会自动跳过，不会重复插入，也不影响学生已绑定的账号和已完成的问卷。
- 名单录错个别信息时，在 CloudBase 控制台「数据库」中直接修改 `dorm_students` 表对应行即可；补录新学生重新执行本脚本。
- `data/students.csv` 在 `.gitignore` 中，真实名单不会被提交到代码仓库。
- 默认支持 4 个班（classId 1—4）。班级数不同时需要同步修改：`database/001_init.sql` 的班级约束、`database/002_formal_rooms.sql` 的寝室号规则、`cloudfunctions/dorm-api/index.js` 里的班级列表。

## 发布前检查

1. 用一名测试学生完成一次问卷并刷新页面，确认数据仍存在。
2. 用另一台手机接受邀请，确认两人/三人组不会被拆开。
3. 确认不同班之间无法互相邀请。
4. 确认错误的辅导员密码无法进入工作台。
5. 确认学生看不到其他人的完整问卷、学号和特殊住宿需求。
6. 生成一次分寝建议，确认系统只给“习惯不相容”提示，不给任何学生贴风险标签。

## 学期或试点结束

系统可以长期重复使用；当一届学生的分寝工作完成、不再需要这份数据时：先从辅导员工作台导出正式结果，再从 CloudBase 控制台导出需要留档的数据。确认辅导员已经保存后，可停止分享网站地址；是否删除环境必须由你再次确认，因为删除后数据可能无法恢复。
