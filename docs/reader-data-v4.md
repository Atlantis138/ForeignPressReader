# 阅读数据与恢复契约 v4

本次改动位于 Unreleased 源码，不改变既有 v1.0.0 发布附件。

## 版本与持久化

migration 4 顺序追加 reader_records 和 FTS5 reader_search，migration 1 及 formal-v1/v2/v3 向量保持原样。原 reading_positions 保留兼容；其写入触发器同时保存文章级位置，升级时将每刊最后位置回填为对应文章位置。没有历史数据的文章从头开始。

reader_records 是平台无关逻辑数据，字段为 recordId/publicationId/articleId/kind/payload/updatedAt/deviceId。payload 是经过种类校验的 JSON 字符串，上限 512000 个 UTF-16 code unit；outer 字段必须精确匹配。位置含 scrollTop、anchorBlockId、anchorTokenIndex、anchorFraction；bookmark/read 为布尔值，false 表示取消。translation-selection 为版本 ID 或 null。

记录 ID 为 kind:articleId；保留译文为 translation:versionId:blockId。版本 ID 是 SHA-256(JSON.stringify([articleId, segments]))，segments 按 blockId 排序，每项依次为 blockId/sourceHash/model/promptVersion/text。段落 payload 使用规范 JSON。相同版本身份而内容不同会拒绝合并。选择版本后只展示 sourceHash 与当前正文匹配的段落。翻译任务开始前保留已有缓存，完成后保留新缓存；中断任务不会伪装成完整版本。

书签、已读、位置、选择与保留译文不依赖本机词典或缓存。删除刊物时保留这些逻辑记录，使同 ID 刊物再次导入可以恢复；FTS 索引不进入备份。用户主动清空全部数据仍删除这些记录。

## 备份与同步

便携格式 v4 必须包含 data/reader-records.ndjson 和 readerRecords 计数，schemaVersion=4。v2/v3 备份仍可合并导入，v4 导入保持幂等并使用 newer-wins。Demo 格式不接受。旧应用不认识 v4，需要先升级应用，不能手工修改版本号。

Sync Model v4 增加 reader-record，LAN wire 路径仍为 /fprsync/v2，线上发现/握手要求双方 modelVersion=4。旧 v2/v3 逻辑批次及冻结向量仍可独立验证；并非跨版本在线推送。发送端胜出、接收端独有记录保留和显式删除墓碑的语义不变。预览每页最多 50 条，界面每页 25 条，长字段只显示摘要；它是批次确认，不提供逐字段择优合并。

v4 peer summary 的 availableBlobHashes 表示解析结构摘要（旧模型表示源内容摘要）。内容摘要为 SHA-256(JSON.stringify([publicationId, sections, articles, blocks]))，固定列顺序见 publication-content.ts 和 publication_repair.rs，共享 reader-records-v4.json 验证两端字节一致。该摘要缓存只存 local.publication-digest.*，不导出；章节/文章/段落变更触发失效。首次冷摘要需扫描正文一次，后续查询使用缓存。

增量先读取 revision/key 元数据并作选择，然后按主键投影选中行；预览/应用也只读取本批次涉及的行。元数据选择仍随记录数增长，不宣称所有同步操作均为 O(1)。

## 同源 EPUB 补全

再次选取相同源摘要的 EPUB 触发当前解析器，补充缺失资源和缺失结构，保留所有原 ID 及用户记录，不删除旧段落。冲突的父 ID/sourceKey/正文会导致事务回滚。用户必须重新提供原文件，应用不重新下载刊物。解析补全可通过内容摘要差异同步到同源设备；它不是覆盖编辑原文的接口。

## 启动恢复

SQLite 快照是本机内部恢复手段，和用于迁移用户数据的 fprbackup 不同。Windows 可选择独立的正式快照文件，Android 可选择本机自动保存的内部快照。恢复先校验正式代际与版本，在独立目录升级并检查完整性，再替换故障库；原文件保留于 recovery/<随机ID>/original。回到较早快照不会包含快照之后新增的记录，界面明确提示。Android 恢复后保留原资源目录，防止把旧快照未引用的资源当垃圾清除。

## Android 媒体服务

FoundationPlaybackService 持有原生队列、TTS、MediaPlayer 和 MediaSession；系统 TTS 先合成为私有临时音频，再通过 MediaPlayer 输出，从而保证媒体按键路由和精确暂停。临时音频在队列结束时清理，不进入备份。通过 mediaPlayback 前台服务维持锁屏朗读。Rust 远程语音生产器只准备当前及下一段，停止/切队列后不再向新会话交付旧音频。密钥不进入队列、Intent、通知或 renderer。

暂停释放 wake lock；失去音频焦点、耳机拔出和停止动作有明确处理。任务被用户从最近应用移除时停止；系统强制结束进程后不自动恢复队列。远程语音仍需要网络和所选服务密钥，停止时已在途的单段请求可能继续完成但不会播放。

平台依据：[Android 后台媒体播放](https://developer.android.com/media/media3/session/background-playback)、[MediaSession](https://developer.android.com/reference/android/media/session/MediaSession)、[前台服务启动规则](https://developer.android.com/develop/background-work/services/fgs/launch)。当前直接使用平台媒体 API，没有引入新的媒体框架依赖。
