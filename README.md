# Pick the Lock · 开锁小游戏

Dota 2 **Dark Carnival** 迷你游戏「Pick the Lock」的浏览器复刻版。

在线试玩：https://betgo.github.io/dota2-lockpick/

## 玩法

- **左键开锁**：锁针转到高亮条上时点击（按住右键加速时仍可左键开锁）
- **黄条**：+1000 分
- **蓝条**：+1.5 秒
- 黄/蓝条**随机出现**，可同时存在多条；每条会**逐渐缩小直至消失**
- 命中后锁针**反向**（只移除被点中的条）
- **按住右键**：持续加速
- **点空**：短暂无法开锁 + 锁针减速（不以固定扣时为主惩罚）
- **通关目标**：6000 分
- **F9**：暂停

## 本地运行

纯静态页面，无需构建：

```bash
python3 -m http.server 8765
# 打开 http://localhost:8765
```

## 机制来源

[Liquipedia · Dark Carnival/Minigames](https://liquipedia.net/dota2/Dark_Carnival/Minigames) 与活动攻略，并按玩家反馈调整：随机生成、条块缩小消失、更慢初始转速。
