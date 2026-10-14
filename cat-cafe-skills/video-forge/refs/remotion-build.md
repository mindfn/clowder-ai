# 工程：怎样把一支片子搭进 Remotion

> API 细节不在这里重复。Remotion 官方的 `remotion-best-practices` skill 按主题分好了 `rules/*.md`，写到哪个 API 就读哪一份。本文件只写"怎样组织一支有品味的片子"和我们实际踩过的版本坑。所有命令在 Remotion 4.0.438 上实测过（2026-10-04）。

## 1. 工程在哪

- **家里**：You 机器上的 Remotion 工作台 `~/projects/remotion-studio`，官方 skill 已装在 `.agents/skills/remotion-best-practices`。那个目录里常有别人没提交的改动：新片子建自己的目录 `src/<Film>/`，用自己的入口文件渲染，不改别人的文件，也不改 `Root.tsx`。
- **别的机器**：`npx create-video@latest` 新建工程，然后在工程里运行 `npx remotion skills add` 装官方 skill。
- 装 Remotion 的包一律用 `npx remotion add <包名>`，它会对齐版本。`npx remotion versions` 检查所有 `@remotion/*` 版本一致，不一致会出各种怪错。

## 2. 一支片子的目录

```
src/<Film>/
  index.ts          // registerRoot，单独入口，渲染时指向它
  Root.tsx          // <Composition>，calculateMetadata 从 timeline 算时长
  theme.ts          // 颜色、字体、字号阶梯、弹簧、时长：全片唯一取值处
  timeline.ts       // 节拍：从配音对齐结果或音乐拍点算出来
  craft/            // 从 video-forge/assets/craft/ 复制过来
  scenes/*.tsx      // 一个节拍一个场景组件，只读 useCurrentFrame()
  Film.tsx          // 把场景按 timeline 排上去
```

`treatment.md`、配音稿、对齐 JSON 放在项目的视频目录里（家里是 `docs/videos/<slug>/`，用 `pnpm video:new <slug>` 生成）。

## 3. 时间线从声音来

- **有配音**：声音稿和多角色对白逐句合成、逐句回听。正式配音如果是单一旁白的连续解说，整篇一次合成（分段会丢语气和呼吸），整段回听一遍再用。两种做法的细则见 `../../.cat-cafe-shared-refs/video-voice-and-timeline.md` §2。时间轴只来自最终用进片子的那版音频，换了音频就重新对齐。强制对齐拿逐词时间：家里是 `scripts/video-forge/align.py`（Qwen3-ForcedAligner），输出 `[{index, word, start_ms, end_ms}]`。不要用 TTS 自带的时间戳。
- `assets/craft/beats.ts` 的 `beatsFromAlignment(words, cues, fps)` 把"每个节拍从哪个词开始"变成帧。画面比词早 4 帧出现，词念到时画面已经能看清。找不到词或顺序错了会直接报错，不会悄悄给个默认值。
- **没有现成音乐**：`scripts/make-score.py` 按小节合成配乐和 13 种音效，段落、和弦、静音区间都用参数给，音乐天然卡在画面网格上（120 BPM、30fps 时一拍 15 帧）。
- **只有音乐**：有稳定 BPM 时，一拍 = `fps × 60 / BPM` 帧。很多氛围、电影感或生成的配乐没有稳定的拍，用 `scripts/music-cues.py <音频> --end-ms <片长>` 取最强的起音点，它直接给出帧号，大的揭示和硬切落在这些帧上（范例 `assets/example/OneSentenceSample.tsx` 就是这么排的）。
- `Root.tsx` 里用 `calculateMetadata` 根据节拍算 `durationInFrames`，并把节拍作为 props 传下去。别在场景里写死帧数。

```tsx
calculateMetadata={async () => {
  const beats = beatsFromAlignment(alignment, cues, FPS);
  const last = beats[beats.length - 1];
  return {durationInFrames: last.from + last.durationInFrames, props: {beats}};
}}
```

- 配音比画面长或短时：先剪画面（TRIM），再定格加一点设计（FREEZE），再补空镜（B_ROLL）。慢放不低于 0.7 倍。加速过的片段，后面所有片段的起点要按输出时长重新累加，不能沿用素材里的时间。

## 4. 镜头：先搭世界，再取景

- 把场景按 1920×1080 搭成一个"世界"，用 `assets/craft/Camera.tsx` 取景：`moves` 里每一项是"在第几帧开始、移到哪"，中间自动停住。缩放在对数空间插值，1 倍推到 4 倍时速度均匀。
- **世界按 zoom = 1 时也好看来排版。** 如果全景时字太小，说明这个世界排得太散；要么收紧排版，要么全景只停 1 秒交代位置。
- 不要给 transform 加 `will-change`：Chrome 会把图层先画成位图再缩放，字会糊。
- 截图要被放大时，按 2 倍像素密度截（`deviceScaleFactor: 2`）；任何位图放大超过 100% 都会糊。

## 5. 产品界面：重建，不要拿截图推拉

- 界面用 React 组件重建，状态完全由帧号决定：`const state = frame < 45 ? 'empty' : frame < 90 ? 'typing' : 'sent'`。不要拿一张截图在上面推拉平移冒充操作。
- 打字：按帧切字符串，`text.slice(0, Math.floor((frame - start) / 2))`（每 2 帧一个字左右）。不要逐字改透明度。
- 流式回复：按行用遮罩揭开，不要逐字闪。
- 光标沿缓动曲线移动，点击时按钮缩到 0.96 再弹回。
- 真实截图只用来当"原件"证据，角标写清楚来源和日期。

## 6. 确定性（渲染出来和预览一样）

- 所有运动只能由 `useCurrentFrame()` 推出。不用 CSS transition / animation、`setTimeout`、`Date.now()`。
- 随机用 `random('seed')`，不用 `Math.random()`。
- 字体用 `@remotion/google-fonts/<Family>` 的 `loadFont()` 或 `@remotion/fonts`；图片用 `<Img>`；它们会等资源加载完再截帧。
- 重的媒体放进 `<Sequence premountFor={...}>` 提前挂载。
- **中文 Google 字体别传 `subsets`**：`loadFont('normal', { weights: ['900'], subsets: ['chinese-simplified'] })` 类型检查能过，渲染时直接抛错 `subset: chinese-simplified is not available`（4.0.438 实测）。只传 `weights`。
- **低清素材先放大再用**：插画、表情图常只有三四百像素。先用 PIL 的 Lanczos 放大两倍，再加轻微锐化（`UnsharpMask(radius=1.4, percent=55)`），画面里的显示尺寸不超过放大后的原尺寸，字和线才不糊。
- 批注（圈、箭头）要画在图片框外层：图片框有 `overflow: hidden` 时，圈到边缘的线会被裁掉。
- **版本坑（家里工作台实测）**：4.0.438 里 `@remotion/media` 的 `<Video>` / `<Audio>` 用 `trimBefore` / `trimAfter`，旧写法 `startFrom` 会类型报错。写视频音频前先读官方 `rules/videos.md`、`rules/audio.md`，别凭记忆。

## 7. 渲染与验片

```bash
# 类型检查（工程里可能有别人的旧报错，只看自己目录的）
npx tsc --noEmit -p . | grep 'src/<Film>/'

# 单帧，最快的检查
npx remotion still src/<Film>/index.ts <CompId> /tmp/f60.png --frame=60 --scale=0.5

# 全片草稿
npx remotion render src/<Film>/index.ts <CompId> /tmp/draft.mp4 --scale=0.5

# 样张：每个节拍的开头、中间、结尾拼成一张图，用 Read 看
bash <skill>/scripts/contact-sheet.sh /tmp/draft.mp4 /tmp/sheet.png 0 12 30 41 ...
```

样张五条自查见 `taste.md` §10。都过了再渲染全尺寸成片：

```bash
npx remotion render src/<Film>/index.ts <CompId> out/<film>.mp4
```

## 8. 给人看

- 成片在 Console 里要能直接播放，不要只贴路径。runtime 的 `/uploads` 猫写不进（guard 拦）：把 mp4 放到主仓 `.cat-cafe/evidence/<主题>/`，发 `kind: "file"`、`mimeType: "video/mp4"`、`url: "/api/workspace/file/raw?worktreeId=cat-cafe&path=.cat-cafe/evidence/<主题>/<文件>.mp4"` 的 rich block（≤10MB，发前 curl 一遍要 200）。细节见 `rich-messaging`。
- 同时附上样张和一页 treatment，写清你替他做了哪些假设，方便他一句话改方向。
- 好不好看由 You 定。别的猫可以审事实、技术、音画同步，不能替他判品味。
