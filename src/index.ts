import {Context, h, Schema} from 'koishi'
import R6API from 'r6api.js-next';
import {GlobalFonts} from "@napi-rs/canvas";
import {rankPicture} from "./util";
import {ButtonData, CachedData, User,} from './types'
import {Kook, KookBot,} from '@koishijs/plugin-adapter-kook'
import {formatYMDHMS, handleServerStatus, KookCardTemp} from "./helper";
import NodeCache from 'node-cache';
import FormData from 'form-data'
import path from "path";

export const name = 'r6s'
declare module 'koishi' {
  interface User {
    bindUser: string
    uPlatform: string
  }
  interface Channel {
    pinMessageId: string
  }
}
export interface Config {}

export interface Config {
  email: string;
  password: string;
  cache: number;
}
export const Config: Schema<Config> = Schema.object({
  email: Schema.string().required().description('UBI 邮箱'),
  password: Schema.string().required().description('UBI 密码'),
  cache: Schema.natural().description('获取账户信息后的缓存时长').default(300)
})

export function apply(ctx: Context, config: Config) {
  const { UBI_EMAIL: email = config.email, UBI_PASSWORD: password = config.password } = process.env;
  const r6api = new R6API({ email, password, ubiAppId: 'e3d5ea9e-50bd-43b7-88bf-39794f4e3d40' });
  const myCache = new NodeCache({ stdTTL: config.cache, useClones: false });
  ctx.i18n.define('zh', require('./locales/zh-CN'))
  ctx.model.extend('user', {
    bindUser: 'string',
    uPlatform: 'string'
  })
  ctx.model.extend('channel', {
    pinMessageId: 'string'
  })

  console.log('Loaded Font : ' + GlobalFonts.registerFromPath(path.join(__dirname, 'assets', 'LXGWWenKaiLite-Regular.ttf'), 'LXGWWenKaiLite'))

  ctx.command('r6rank [name:string]')    .option('xbox', '-x')
    .option('psn', '-p')
    .option('session', '-s [session:posint]')
    .userFields(['bindUser', 'uPlatform'])
    .action(async ({session, options}, name) => {
      let platform: any = 'uplay'
      if (options.xbox) platform = 'xbl'
      if (options.psn) platform = 'psn'
      let user;
      if (name == undefined) {
        if (session.user.bindUser) {
          const platform = session.user.uPlatform as  "uplay" | "xbl" | "psn"
          user = await r6api.findUserById({platform: platform, ids: [session.user.bindUser], isUserIds: true})
        } else {
          return session.text('.no-name')
        }
      } else user = await r6api.findUserByUsername({platform: platform, usernames: [name]})

      if (!user[0]) return session.text('.not-found')

      const target : User = user[0]
      const [seasonal, status] =
        await Promise.all([profileInfoCache(target.profileId, platform),
          r6api.getUserStatus({userIds: [target.userId]})]);

      if (session.platform == 'kook') {
        await session.kook.createMessage({
          target_id: session.channelId,
          type: Kook.Type.card,
          content: JSON.stringify([KookCardTemp.RankInfoCard(target, seasonal.data.Profile, seasonal.data.Ranked, status[0].status)]),
        })
        return
      }
      const buffer = await rankPicture(target, seasonal.data.Profile, seasonal.data.Ranked, status[0].status)
      await session.send(h.image(buffer, 'image/png'))
  })

  ctx.command('r6bind <user:string>').userFields(['bindUser', 'uPlatform'])
    .option('xbox', '-x')
    .option('psn', '-p')
    .action(async ({session, options}, user) => {
      if (user == undefined) return session.send(session.text('.no-name'))
      let platform: any = 'uplay'
      if (options.xbox) platform = 'xbl'
      if (options.psn) platform = 'psn'
      const query = await r6api.findUserByUsername({platform: platform, usernames: [user]})

      if (!query[0]) return session.text('.not-found')

      const target : User = query[0]

      if (session.platform == 'kook') {
        await session.kook.createMessage({
          target_id: session.channelId,
          type: Kook.Type.card,
          content: JSON.stringify([KookCardTemp.BindCard(target)]),
          temp_target_id: session.userId
        })
        return
      }
      session.user.bindUser = target.userId
      session.user.uPlatform = target.platform
      await session.send(session.text('.success', [target.username, target.userId]))
    });

  ctx.command('r6server')
    .action(async ({session}) => {
      const status = await r6api.getServiceStatus()
      const result = await handleServerStatus(status)
      await session.send(h('message', result.join('\n')))
  })

  ctx.platform('kook').command('friend').userFields(['bindUser', 'uPlatform'])
    .action(async ({session}) => {
      if (!session.user.bindUser) return session.text('.no-account')

      const platform = session.user.uPlatform as  "uplay" | "xbl" | "psn"
      const user = await r6api.findUserById({platform: platform, ids: [session.user.bindUser], isUserIds: true})
      if (!user[0]) return session.text('.not-found')
      const kookUser = await session.kook.getUserView({user_id: session.userId})
      const target : User = user[0]
      await session.kook.createMessage({
        type: Kook.Type.card,
        content: JSON.stringify([KookCardTemp.FriendCard(target, kookUser.username, kookUser.avatar)]),
        target_id: session.channelId
      })
      await session.kook.deleteMessage({msg_id: session.messageId})
  })

  ctx.platform('kook').command('r6pin').channelFields(['pinMessageId'])
    .action(async ({session}) => {
      const status = await r6api.getServiceStatus()
      const result = await handleServerStatus(status)
      if (session.channel.pinMessageId) {
        await session.kook.updateMessage({
          msg_id: session.channel.pinMessageId,
          content: JSON.stringify([KookCardTemp.ServerStatusCard(result.join('\n'), formatYMDHMS(new Date()))])
        })
        // 结束，一个指令既可以更新也可以创建，计时功能交给 koishi-plugin-schedule
        return
      }
      session.channel.pinMessageId = (await session.kook.createMessage({
        target_id: session.channelId,
        type: Kook.Type.card,
        content: JSON.stringify([KookCardTemp.ServerStatusCard(result.join('\n'), formatYMDHMS(new Date()))])
      })).msg_id;
  })

  ctx.platform('kook').on('message-deleted', async (session) => {
    await ctx.database.set('channel', {
      pinMessageId: [session.messageId],
    }, {
      pinMessageId: null
    })
  })

  ctx.on('kook/message-btn-click', async (session) => {
    if (session.content.startsWith('confirm')) {
      const match = session.content.match(/confirm_(.*)_(.*)/)
      await ctx.database.setUser(session.platform, session.userId, {bindUser: match[1], uPlatform: match[2]})
      await session.kook.createMessage({target_id: session.targetId, content: '绑定成功', temp_target_id: session.userId})
      return
    }
    let btn: ButtonData
    try {
      btn = JSON.parse(session.content)
    } catch { return }

    if (btn.type !== "r6lookup") return
    const data = btn.data
    const [seasonal, status] =
      await Promise.all([profileInfoCache(data.user.profileId, data.user.platform),
        r6api.getUserStatus({userIds: [data.user.userId]})]);

    if (btn.action == "picture") {
      const buffer = await rankPicture(data.user, seasonal.data.Profile, seasonal.data.Ranked, status[0].status)
      const bot = session.bot as KookBot
      const payload = new FormData()
      payload.append('file', buffer, {
        filename: session.userId,
      })
      const { url } = await bot.request("post", "/asset/create", payload, payload.getHeaders())
      await session.kook.createMessage({type: Kook.Type.image, content: url, target_id: session.targetId, temp_target_id: session.userId})
      return
    }

    let CardTemplate = KookCardTemp.RankInfoCard(data.user, seasonal.data.Profile, seasonal.data.Ranked, status[0].status)
    switch (btn.action) {
      case "rank": CardTemplate =
        KookCardTemp.RankInfoCard(data.user, seasonal.data.Profile, seasonal.data.Ranked, status[0].status);
      break
      case "casual": CardTemplate =
        KookCardTemp.CasualInfoCard(data.user, seasonal.data.Profile, seasonal.data.Casual, status[0].status);
      break
      case "warmup": CardTemplate =
        KookCardTemp.WarmupInfoCard(data.user, seasonal.data.Profile, seasonal.data.Warmup, status[0].status)
    }
    if (seasonal.fromCache) {
        await session.kook.updateMessage({
          content: JSON.stringify([CardTemplate]),
          msg_id: session.messageId,
          temp_target_id: session.userId
        })
      } else
      await session.kook.createMessage({
      target_id: session.targetId,
      type: Kook.Type.card,
      content: JSON.stringify([CardTemplate]),
    })
  })

  const profileInfoCache = async (profilesId: string, platform: "uplay" | "xbl" | "psn"): Promise<{
    fromCache: boolean; data: CachedData;
  }> => {
    // 先尝试从缓存中获取数据
    const cachedData : CachedData = myCache.get(profilesId);

    if (cachedData) {
      return {data: cachedData, fromCache: true};
    }

    let platformsFamilies : "pc" | "console" = "pc"
    if (platform !== "uplay") platformsFamilies = "console"
    // 如果缓存中没有数据，则从API获取
    const [seasonal, progress] = await Promise.all([r6api.getUserSeasonalv2({
      platformsFamilies: [platformsFamilies],
      profileIds: [profilesId]
    }), (await r6api.getUserProgression({profileIds: [profilesId], platform: platform}))])
    const  { rank, maxRank, season, topRankPosition,
      kills, deaths, kd, wins, losses, winRate, matches, abandons } =
      seasonal.filter(s => s.platform == platformsFamilies && s.board.slug == 'ranked')[0]
    const  { kills: cKills, deaths: cDeaths, kd: cKD, wins: cWins, losses: cLosses, winRate: cWinRate, matches: cMatches, abandons: cAbandons } =
      seasonal.filter(s => s.platform == platformsFamilies && s.board.slug == 'casual')[0]
    const  { kills: wKills, deaths: wDeaths, kd: wKD, wins: wWins, losses: wLosses, winRate: wWinRate, matches: wMatches, abandons: wAbandons } =
      seasonal.filter(s => s.platform == platformsFamilies && s.board.slug == 'warmup')[0]
    const { level, xp, lootboxProbability } = progress[0]
    const data = {
      Profile: {
        season, platformsFamilies, level, xp, lootboxProbability
      },
      Ranked: {
        rank, maxRank, topRankPosition, kills, deaths, kd, wins, losses, winRate, matches, abandons
      },
      Casual: {
        cKills, cDeaths, cKD, cWins, cLosses, cWinRate, cMatches, cAbandons
      },
      Warmup: {
        wKills, wDeaths, wKD, wWins, wLosses, wWinRate, wMatches, wAbandons
      },
    }

    // 将新获取的数据放入缓存中
    myCache.set(profilesId, data);

    return {data: data, fromCache: false};
  };
}
