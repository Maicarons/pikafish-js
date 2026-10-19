## 背景

<!-- 为什么需要这个改动？关联 issue：Closes # -->

## 改动

<!-- 关键决策与取舍，不需要逐文件罗列 -->

## 验证

<!-- 勾选并补充实际执行的命令/浏览器 -->

- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm run typecheck`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] `npm run test:e2e`（UI、Worker、构建相关改动必跑；说明跑了哪些浏览器）
- [ ] `node scripts/check-links.mjs`（文档改动）
- [ ] 三套构建手动验证（构建参数、wasm、权重相关改动）

补充说明：

## 影响面

- [ ] 改变公共 API（需要 changeset 与文档）
- [ ] 改变引擎/wasm 行为（需要重跑基准并更新实测数据）
- [ ] 改变裁决规则（需要新增单测与 test fixture）
- [ ] 仅文档 / 注释

## 截图

<!-- UI 改动请附前后对比 -->
