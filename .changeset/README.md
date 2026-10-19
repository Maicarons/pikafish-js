# Changesets

这个目录由 [`changesets`](https://github.com/changesets/changesets) 管理版本与变更日志。

## 当前状态

`0.1.0` 是首次发布，版本号已经写在两个包的 `package.json` 里，因此**没有待处理的 changeset**；
对应的记录直接放在各包的 `CHANGELOG.md`。

## 从 0.1.1 开始

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
