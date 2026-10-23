# Changesets

这个目录由 [`changesets`](https://github.com/changesets/changesets) 管理版本与变更日志。

## 当前状态

`1.0.0` 是当前发布版本（`pikafish-js` 与 `@pikafish-js/rules`），已发布到 npm，`latest` 指向
1.0.0。版本号已经写在两个包的 `package.json` 里，因此**没有待处理的 changeset**；对应的记录
直接放在各包的 `CHANGELOG.md`。

## 从 1.0.1 开始

每个改变已发布包的 PR 都附一个 changeset：

```bash
npx changeset
```

选择包与变更级别（`patch` / `minor` / `major`），写一句面向使用者的说明。合并后由维护者在发布时执行：

```bash
npx changeset version     # 消耗 changeset，更新版本与 CHANGELOG
npm run build && npm run check:pack
git commit -am "chore: release vX.Y.Z"
git tag vX.Y.Z            # 触发 release.yml
```

`release.yml` 不再直接 `npm publish`，而是把两个包提交到 npm 暂存队列；维护者在 npmjs.com 的
Staged Packages 页面或本地执行 `npm stage approve <stage-id>`（需要 2FA）后，包才会公开。
`latest` / `legacy` 等标签在暂存时就已固定。

> `@pikafish-js/rules` 属于 npm 组织 `pikafish-js`。`NPM_TOKEN` 必须对该组织有读写权限，
> 否则暂存会返回 `E404 Scope not found`（首次发布时就因组织尚未创建而失败过）。

约定：

- **`major`** 只用于真正不兼容的 API 变更（`0.x` 期间允许 `minor` 破坏，但要在 CHANGELOG 里写明）；
- 演示站 `@pikafish-js/demo` 是私有包，不发布，也不记 changeset；
- 只改文档、CI、测试的 PR 不需要 changeset。

## CI 发布

`.github/workflows/release.yml` 在 `v*` tag 上会：跑单测、编译九套 wasm、校验体积、校验
npm 包内容、创建/更新 GitHub Release（Release 说明取 `docs/releases/<tag>.md`），最后把两个包
提交到 npm 暂存队列（`npm stage publish --provenance`）。`NPM_TOKEN` 为空时这一步会失败，
不会静默跳过；暂存成功后还需要维护者用 2FA 批准，包才会公开。

`check-pack` 会验证 `repository` 与 `publishConfig.access`，因为 provenance 签名要求前者，
后者写错要等到发布时才报错。
