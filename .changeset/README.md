# Changesets

这个目录由 [`changesets`](https://github.com/changesets/changesets) 管理版本与变更日志。

## 当前状态

`1.0.0` 是当前发布版本（`pikafish-js` 与 `@pikafish-js/rules`），版本号已经写在两个包的
`package.json` 里，因此**没有待处理的 changeset**；对应的记录直接放在各包的 `CHANGELOG.md`。

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
npm publish --provenance --workspace pikafish-js --workspace @pikafish-js/rules
```

约定：

- **`major`** 只用于真正不兼容的 API 变更（`0.x` 期间允许 `minor` 破坏，但要在 CHANGELOG 里写明）；
- 演示站 `@pikafish-js/demo` 是私有包，不发布，也不记 changeset；
- 只改文档、CI、测试的 PR 不需要 changeset。

## CI 发布

`.github/workflows/release.yml` 在 `v*` tag 上会：跑单测、编译十八套 wasm、校验体积、校验
npm 包内容、创建/更新 GitHub Release（Release 说明取 `docs/releases/<tag>.md`），最后**如果配置了
`NPM_TOKEN` secret** 才执行 `npm publish --provenance`。没有该 secret 时发布会跳过并留一条
notice，不会让整个 release 失败。

`check-pack` 会验证 `repository` 与 `publishConfig.access`，因为 provenance 签名要求前者，
后者写错要等到发布时才报错。
