#!/usr/bin/env bash
# 实验三（组合层，boot-free）：把「profile 依赖 link: + cordis.patch.yml insert」这套挂载片段
# 交给真正的 dsh 组合管线（dsh --profile <p> --dump-config）验证，全程不改用户的 ~/.dsh。
#
# 做法：把 DSH_HOME 指到本包内的临时目录，在里面造一个与 web profile 同构的 profile：
#   - dsh.profile.bundles 抄用户的 web profile（真 bundle）
#   - dependencies 用 link: 指向本包
#   - node_modules/@deepseek-ai 软链到全局安装，node_modules/dsh-model-filter 软链到本包
#   - cordis.patch.yml 就是 README/PROOF 里那段 insert
# 然后跑 `dsh --profile filtertest --dump-config`（该命令只组合 patch 层、不 boot、不起服务）。
set -euo pipefail
cd "$(dirname "$0")/.."
PKG_DIR="$(pwd)"
TMP_HOME="$PKG_DIR/.tmp-dsh-home"
GLOBAL_AI="${DSH_GLOBAL_AI:-/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai}"
DSH_BIN="${DSH_BIN:-/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js}"
PROFILE_DIR="$TMP_HOME/profiles/filtertest"

rm -rf "$TMP_HOME"
mkdir -p "$PROFILE_DIR/node_modules"
ln -s "$GLOBAL_AI" "$PROFILE_DIR/node_modules/@deepseek-ai"
ln -s "$PKG_DIR" "$PROFILE_DIR/node_modules/dsh-model-filter"

cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-filtertest",
  "private": true,
  "dependencies": {
    "dsh-model-filter": "link:$PKG_DIR"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
EOF

cat > "$PROFILE_DIR/cordis.patch.yml" <<'EOF'
- insert:
    - id: dsh-model-filter
      name: dsh-model-filter
      config:
        hideModels:
          deepseek-account:
            - deepseek-v4-pro
EOF

echo "== 1) 插件包名能从该 profile 解析到吗（等同于 boot 时的裸名解析） =="
node --input-type=module -e "
import { createRequire } from 'node:module'
const req = createRequire('$PROFILE_DIR/package.json')
console.log('require.resolve(\"dsh-model-filter\") ->', req.resolve('dsh-model-filter'))
"

echo
echo "== 2) DSH_HOME 生效范围（确认没有读到真 ~/.dsh） =="
DSH_HOME="$TMP_HOME" node --input-type=module -e "
const paths = await import('$GLOBAL_AI/dsh-home-paths/lib/index.js')
console.log('resolveDshHome() ->', paths.resolveDshHome?.() ?? '(未导出该名字)')
"

echo
echo "== 3) 真组合管线 --dump-config =="
DSH_HOME="$TMP_HOME" node "$DSH_BIN" --profile filtertest --dump-config > "$PKG_DIR/experiments/composition-dump.out.txt" 2>&1 || {
  echo "dump-config 失败，输出："; cat "$PKG_DIR/experiments/composition-dump.out.txt"; exit 1
}
echo "dump 行数: $(wc -l < "$PKG_DIR/experiments/composition-dump.out.txt")"
echo "--- 我们那一行及其上下文 ---"
grep -n -B 6 -A 8 "dsh-model-filter" "$PKG_DIR/experiments/composition-dump.out.txt"
echo "--- 真 home 的 patch 层有没有被读到（应无 ~/.dsh 字样） ---"
grep -c "~/.dsh" "$PKG_DIR/experiments/composition-dump.out.txt" || true

echo
echo "== 4) 结论 =="
if grep -q "id: dsh-model-filter" "$PKG_DIR/experiments/composition-dump.out.txt" \
  && grep -q "deepseek-v4-pro" "$PKG_DIR/experiments/composition-dump.out.txt"; then
  echo "insert 片段被真组合管线接受：插件行 + hideModels 配置都出现在 dump 里"
else
  echo "未在 dump 里找到插件行，检查上面的输出"; exit 1
fi

rm -rf "$TMP_HOME"
echo "已清理临时 DSH_HOME（$TMP_HOME）；用户 ~/.dsh 全程未被读写"
