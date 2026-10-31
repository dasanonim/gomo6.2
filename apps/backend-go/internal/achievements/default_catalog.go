package achievements

// Default returns the production quest catalog.
//
// Three blocks, everything visible with progress, every level claimable:
//   - first_steps: the onboarding checklist (free order, one_time each) plus
//     the meta quest for completing all 9 (drops + gems + a chest).
//   - main: progressive ladders (entries, comments, likes, subs, follows,
//     gifts, media, friends, visits, tenure).
//
// Economy (agreed in the kvestikiref rework): drops stay modest on low levels
// (anti-inflation, ~500–1000 for an active first month), tops get fatter, gems
// land on the final level of every track, chests only on the upper levels of
// the hard tracks. No hidden quests, no prestige, no manual awards here.
func Default() (*Catalog, error) {
	drops := func(amount int) []Reward { return []Reward{{Kind: RewardDrops, Amount: amount}} }
	gems := func(d, g int) []Reward {
		return []Reward{{Kind: RewardDrops, Amount: d}, {Kind: RewardGems, Amount: g}}
	}
	chest := Reward{Kind: RewardChest, Mechanic: "rarity_chest"}
	withChest := func(d, g int, chests int) []Reward {
		out := []Reward{{Kind: RewardDrops, Amount: d}, {Kind: RewardGems, Amount: g}}
		for i := 0; i < chests; i++ {
			out = append(out, chest)
		}
		return out
	}
	withDropsChest := func(d int, chests int) []Reward {
		out := []Reward{{Kind: RewardDrops, Amount: d}}
		for i := 0; i < chests; i++ {
			out = append(out, chest)
		}
		return out
	}
	return NewCatalog([]*Group{
		// ── First steps (onboarding checklist, free order) ───────────────────
		{
			Key: "qs_avatar", TitleKey: "achievements.qs_avatar.title", Category: CategoryProfile,
			Icon: "smile", Kind: KindMilestone, Type: TypeOneTime,
			Stat: StatCounter, Track: TrackFirstSteps, SortOrder: 1,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.qs_avatar.1.name", DescriptionKey: "achievements.qs_avatar.1.description", Rewards: drops(12)},
			},
		},
		{
			Key: "qs_bio", TitleKey: "achievements.qs_bio.title", Category: CategoryProfile,
			Icon: "id-card", Kind: KindMilestone, Type: TypeOneTime,
			Stat: StatCounter, Track: TrackFirstSteps, SortOrder: 2,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.qs_bio.1.name", DescriptionKey: "achievements.qs_bio.1.description", Rewards: drops(10)},
			},
		},
		{
			Key: "qs_first_thread", TitleKey: "achievements.qs_first_thread.title", Category: CategoryContent,
			Icon: "message-square", Kind: KindMilestone, Type: TypeOneTime,
			Stat: StatCounter, Track: TrackFirstSteps, SortOrder: 3,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.qs_first_thread.1.name", DescriptionKey: "achievements.qs_first_thread.1.description", Rewards: drops(12)},
			},
		},
		{
			Key: "qs_first_wall", TitleKey: "achievements.qs_first_wall.title", Category: CategoryContent,
			Icon: "pen-line", Kind: KindMilestone, Type: TypeOneTime,
			Stat: StatCounter, Track: TrackFirstSteps, SortOrder: 4,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.qs_first_wall.1.name", DescriptionKey: "achievements.qs_first_wall.1.description", Rewards: drops(12)},
			},
		},
		{
			Key: "qs_first_comment", TitleKey: "achievements.qs_first_comment.title", Category: CategoryContent,
			Icon: "messages-square", Kind: KindMilestone, Type: TypeOneTime,
			Stat: StatCounter, Track: TrackFirstSteps, SortOrder: 5,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.qs_first_comment.1.name", DescriptionKey: "achievements.qs_first_comment.1.description", Rewards: drops(8)},
			},
		},
		{
			Key: "qs_like_given", TitleKey: "achievements.qs_like_given.title", Category: CategoryContent,
			Icon: "heart", Kind: KindMilestone, Type: TypeOneTime,
			Stat: StatCounter, Track: TrackFirstSteps, SortOrder: 6,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.qs_like_given.1.name", DescriptionKey: "achievements.qs_like_given.1.description", Rewards: drops(8)},
			},
		},
		{
			Key: "qs_sub_join", TitleKey: "achievements.qs_sub_join.title", Category: CategoryCommunity,
			Icon: "users", Kind: KindMilestone, Type: TypeOneTime,
			Stat: StatCounter, Track: TrackFirstSteps, SortOrder: 7,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.qs_sub_join.1.name", DescriptionKey: "achievements.qs_sub_join.1.description", Rewards: drops(8)},
			},
		},
		{
			Key: "qs_follow", TitleKey: "achievements.qs_follow.title", Category: CategorySocial,
			Icon: "user-plus", Kind: KindMilestone, Type: TypeOneTime,
			Stat: StatCounter, Track: TrackFirstSteps, SortOrder: 8,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.qs_follow.1.name", DescriptionKey: "achievements.qs_follow.1.description", Rewards: drops(8)},
			},
		},
		{
			Key: "qs_style", TitleKey: "achievements.qs_style.title", Category: CategoryProfile,
			Icon: "palette", Kind: KindMilestone, Type: TypeOneTime,
			Stat: StatCounter, Track: TrackFirstSteps, SortOrder: 9,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.qs_style.1.name", DescriptionKey: "achievements.qs_style.1.description", Rewards: drops(10)},
			},
		},
		{
			// Meta: all 9 first steps done. Derived from the other quests'
			// levels, so its own threshold is the count (9).
			Key: "qs_complete", TitleKey: "achievements.qs_complete.title", Category: CategoryOnboarding,
			Icon: "trophy", Kind: KindMilestone, Type: TypeOneTime,
			Stat: StatDerived, Track: TrackFirstSteps, SortOrder: 10,
			Levels: []Level{
				{Level: 1, Threshold: 9, NameKey: "achievements.qs_complete.1.name", DescriptionKey: "achievements.qs_complete.1.description",
					Rewards: []Reward{{Kind: RewardDrops, Amount: 80}, {Kind: RewardGems, Amount: 5}, chest}},
			},
		},

		// ── Main ladder: content ─────────────────────────────────────────────
		{
			Key: "entries", TitleKey: "achievements.entries.title", Category: CategoryContent,
			Icon: "notebook-pen", Kind: KindMilestone, Type: TypeProgressive,
			Stat: StatCounter, Track: TrackMain, SortOrder: 20,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.entries.1.name", DescriptionKey: "achievements.entries.1.description", Rewards: drops(8)},
				{Level: 2, Threshold: 10, NameKey: "achievements.entries.2.name", DescriptionKey: "achievements.entries.2.description", Rewards: drops(20)},
				{Level: 3, Threshold: 25, NameKey: "achievements.entries.3.name", DescriptionKey: "achievements.entries.3.description", Rewards: drops(45)},
				{Level: 4, Threshold: 100, NameKey: "achievements.entries.4.name", DescriptionKey: "achievements.entries.4.description", Rewards: drops(120)},
				{Level: 5, Threshold: 500, NameKey: "achievements.entries.5.name", DescriptionKey: "achievements.entries.5.description", Rewards: withDropsChest(300, 1)},
				{Level: 6, Threshold: 1500, NameKey: "achievements.entries.6.name", DescriptionKey: "achievements.entries.6.description", Rewards: withChest(600, 15, 2)},
			},
		},
		{
			Key: "comments", TitleKey: "achievements.comments.title", Category: CategoryContent,
			Icon: "messages-square", Kind: KindMilestone, Type: TypeProgressive,
			Stat: StatCounter, Track: TrackMain, SortOrder: 21,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.comments.1.name", DescriptionKey: "achievements.comments.1.description", Rewards: drops(8)},
				{Level: 2, Threshold: 15, NameKey: "achievements.comments.2.name", DescriptionKey: "achievements.comments.2.description", Rewards: drops(25)},
				{Level: 3, Threshold: 60, NameKey: "achievements.comments.3.name", DescriptionKey: "achievements.comments.3.description", Rewards: drops(70)},
				{Level: 4, Threshold: 250, NameKey: "achievements.comments.4.name", DescriptionKey: "achievements.comments.4.description", Rewards: withDropsChest(200, 1)},
				{Level: 5, Threshold: 1000, NameKey: "achievements.comments.5.name", DescriptionKey: "achievements.comments.5.description", Rewards: withChest(400, 10, 1)},
			},
		},
		{
			Key: "likes_given", TitleKey: "achievements.likes_given.title", Category: CategoryContent,
			Icon: "heart-handshake", Kind: KindMilestone, Type: TypeProgressive,
			Stat: StatCounter, Track: TrackMain, SortOrder: 22,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.likes_given.1.name", DescriptionKey: "achievements.likes_given.1.description", Rewards: drops(8)},
				{Level: 2, Threshold: 25, NameKey: "achievements.likes_given.2.name", DescriptionKey: "achievements.likes_given.2.description", Rewards: drops(30)},
				{Level: 3, Threshold: 100, NameKey: "achievements.likes_given.3.name", DescriptionKey: "achievements.likes_given.3.description", Rewards: drops(80)},
				{Level: 4, Threshold: 500, NameKey: "achievements.likes_given.4.name", DescriptionKey: "achievements.likes_given.4.description", Rewards: drops(200)},
				{Level: 5, Threshold: 1500, NameKey: "achievements.likes_given.5.name", DescriptionKey: "achievements.likes_given.5.description", Rewards: gems(350, 10)},
			},
		},
		{
			Key: "likes_received", TitleKey: "achievements.likes_received.title", Category: CategoryContent,
			Icon: "heart", Kind: KindMilestone, Type: TypeProgressive,
			Stat: StatCounter, Track: TrackMain, SortOrder: 23,
			Levels: []Level{
				{Level: 1, Threshold: 10, NameKey: "achievements.likes_received.1.name", DescriptionKey: "achievements.likes_received.1.description", Rewards: drops(12)},
				{Level: 2, Threshold: 50, NameKey: "achievements.likes_received.2.name", DescriptionKey: "achievements.likes_received.2.description", Rewards: drops(40)},
				{Level: 3, Threshold: 200, NameKey: "achievements.likes_received.3.name", DescriptionKey: "achievements.likes_received.3.description", Rewards: withDropsChest(120, 1)},
				{Level: 4, Threshold: 800, NameKey: "achievements.likes_received.4.name", DescriptionKey: "achievements.likes_received.4.description", Rewards: withDropsChest(350, 1)},
				{Level: 5, Threshold: 3000, NameKey: "achievements.likes_received.5.name", DescriptionKey: "achievements.likes_received.5.description", Rewards: withChest(600, 15, 2)},
			},
		},
		{
			Key: "media_uploads", TitleKey: "achievements.media_uploads.title", Category: CategoryContent,
			Icon: "camera", Kind: KindMilestone, Type: TypeProgressive,
			Stat: StatCounter, Track: TrackMain, SortOrder: 24,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.media_uploads.1.name", DescriptionKey: "achievements.media_uploads.1.description", Rewards: drops(8)},
				{Level: 2, Threshold: 10, NameKey: "achievements.media_uploads.2.name", DescriptionKey: "achievements.media_uploads.2.description", Rewards: drops(30)},
				{Level: 3, Threshold: 50, NameKey: "achievements.media_uploads.3.name", DescriptionKey: "achievements.media_uploads.3.description", Rewards: drops(100)},
				{Level: 4, Threshold: 200, NameKey: "achievements.media_uploads.4.name", DescriptionKey: "achievements.media_uploads.4.description", Rewards: withChest(300, 10, 1)},
			},
		},

		// ── Main ladder: community & social ──────────────────────────────────
		{
			Key: "subs_joined", TitleKey: "achievements.subs_joined.title", Category: CategoryCommunity,
			Icon: "users", Kind: KindMilestone, Type: TypeProgressive,
			Stat: StatCounter, Track: TrackMain, SortOrder: 25,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.subs_joined.1.name", DescriptionKey: "achievements.subs_joined.1.description", Rewards: drops(8)},
				{Level: 2, Threshold: 3, NameKey: "achievements.subs_joined.2.name", DescriptionKey: "achievements.subs_joined.2.description", Rewards: drops(25)},
				{Level: 3, Threshold: 8, NameKey: "achievements.subs_joined.3.name", DescriptionKey: "achievements.subs_joined.3.description", Rewards: drops(60)},
				{Level: 4, Threshold: 20, NameKey: "achievements.subs_joined.4.name", DescriptionKey: "achievements.subs_joined.4.description", Rewards: gems(120, 5)},
			},
		},
		{
			Key: "sub_created", TitleKey: "achievements.sub_created.title", Category: CategoryCommunity,
			Icon: "flag", Kind: KindMilestone, Type: TypeOneTime,
			Stat: StatCounter, Track: TrackMain, SortOrder: 26,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.sub_created.1.name", DescriptionKey: "achievements.sub_created.1.description",
					Rewards: []Reward{{Kind: RewardDrops, Amount: 40}, {Kind: RewardGems, Amount: 5}}},
			},
		},
		{
			Key: "follows", TitleKey: "achievements.follows.title", Category: CategorySocial,
			Icon: "user-plus", Kind: KindMilestone, Type: TypeProgressive,
			Stat: StatCounter, Track: TrackMain, SortOrder: 27,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.follows.1.name", DescriptionKey: "achievements.follows.1.description", Rewards: drops(8)},
				{Level: 2, Threshold: 5, NameKey: "achievements.follows.2.name", DescriptionKey: "achievements.follows.2.description", Rewards: drops(25)},
				{Level: 3, Threshold: 20, NameKey: "achievements.follows.3.name", DescriptionKey: "achievements.follows.3.description", Rewards: drops(70)},
				{Level: 4, Threshold: 80, NameKey: "achievements.follows.4.name", DescriptionKey: "achievements.follows.4.description", Rewards: gems(200, 8)},
			},
		},
		{
			Key: "friends_mutual", TitleKey: "achievements.friends_mutual.title", Category: CategorySocial,
			Icon: "heart-handshake", Kind: KindMilestone, Type: TypeProgressive,
			Stat: StatCounter, Track: TrackMain, SortOrder: 28,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.friends_mutual.1.name", DescriptionKey: "achievements.friends_mutual.1.description", Rewards: drops(10)},
				{Level: 2, Threshold: 5, NameKey: "achievements.friends_mutual.2.name", DescriptionKey: "achievements.friends_mutual.2.description", Rewards: drops(35)},
				{Level: 3, Threshold: 15, NameKey: "achievements.friends_mutual.3.name", DescriptionKey: "achievements.friends_mutual.3.description", Rewards: gems(100, 5)},
			},
		},
		{
			Key: "gifts_sent", TitleKey: "achievements.gifts_sent.title", Category: CategorySocial,
			Icon: "gift", Kind: KindMilestone, Type: TypeProgressive,
			Stat: StatCounter, Track: TrackMain, SortOrder: 29,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.gifts_sent.1.name", DescriptionKey: "achievements.gifts_sent.1.description", Rewards: drops(10)},
				{Level: 2, Threshold: 5, NameKey: "achievements.gifts_sent.2.name", DescriptionKey: "achievements.gifts_sent.2.description", Rewards: drops(40)},
				{Level: 3, Threshold: 25, NameKey: "achievements.gifts_sent.3.name", DescriptionKey: "achievements.gifts_sent.3.description", Rewards: gems(120, 5)},
			},
		},
		{
			Key: "gifts_received", TitleKey: "achievements.gifts_received.title", Category: CategorySocial,
			Icon: "package-open", Kind: KindMilestone, Type: TypeProgressive,
			Stat: StatCounter, Track: TrackMain, SortOrder: 30,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "achievements.gifts_received.1.name", DescriptionKey: "achievements.gifts_received.1.description", Rewards: drops(10)},
				{Level: 2, Threshold: 5, NameKey: "achievements.gifts_received.2.name", DescriptionKey: "achievements.gifts_received.2.description", Rewards: drops(40)},
				{Level: 3, Threshold: 25, NameKey: "achievements.gifts_received.3.name", DescriptionKey: "achievements.gifts_received.3.description", Rewards: gems(120, 5)},
			},
		},
		{
			Key: "visits_total", TitleKey: "achievements.visits_total.title", Category: CategorySocial,
			Icon: "calendar-check", Kind: KindMilestone, Type: TypeProgressive,
			Stat: StatCounter, Track: TrackMain, SortOrder: 31,
			Levels: []Level{
				{Level: 1, Threshold: 3, NameKey: "achievements.visits_total.1.name", DescriptionKey: "achievements.visits_total.1.description", Rewards: drops(10)},
				{Level: 2, Threshold: 10, NameKey: "achievements.visits_total.2.name", DescriptionKey: "achievements.visits_total.2.description", Rewards: drops(30)},
				{Level: 3, Threshold: 30, NameKey: "achievements.visits_total.3.name", DescriptionKey: "achievements.visits_total.3.description", Rewards: drops(80)},
				{Level: 4, Threshold: 100, NameKey: "achievements.visits_total.4.name", DescriptionKey: "achievements.visits_total.4.description", Rewards: drops(200)},
				{Level: 5, Threshold: 365, NameKey: "achievements.visits_total.5.name", DescriptionKey: "achievements.visits_total.5.description", Rewards: gems(400, 10)},
			},
		},
		{
			Key: "visit_streak", TitleKey: "achievements.visit_streak.title", Category: CategorySocial,
			Icon: "flame", Kind: KindMilestone, Type: TypeProgressive,
			Stat: StatCounter, Track: TrackMain, SortOrder: 32,
			Levels: []Level{
				{Level: 1, Threshold: 3, NameKey: "achievements.visit_streak.1.name", DescriptionKey: "achievements.visit_streak.1.description", Rewards: drops(15)},
				{Level: 2, Threshold: 7, NameKey: "achievements.visit_streak.2.name", DescriptionKey: "achievements.visit_streak.2.description", Rewards: drops(40)},
				{Level: 3, Threshold: 14, NameKey: "achievements.visit_streak.3.name", DescriptionKey: "achievements.visit_streak.3.description", Rewards: drops(100)},
				{Level: 4, Threshold: 30, NameKey: "achievements.visit_streak.4.name", DescriptionKey: "achievements.visit_streak.4.description", Rewards: withChest(250, 8, 1)},
			},
		},
		{
			Key: "tenure_days", TitleKey: "achievements.tenure_days.title", Category: CategoryProfile,
			Icon: "clock", Kind: KindMilestone, Type: TypeProgressive,
			Stat: StatCounter, Track: TrackMain, SortOrder: 33,
			Levels: []Level{
				{Level: 1, Threshold: 10, NameKey: "achievements.tenure_days.1.name", DescriptionKey: "achievements.tenure_days.1.description", Rewards: drops(20)},
				{Level: 2, Threshold: 30, NameKey: "achievements.tenure_days.2.name", DescriptionKey: "achievements.tenure_days.2.description", Rewards: drops(60)},
				{Level: 3, Threshold: 100, NameKey: "achievements.tenure_days.3.name", DescriptionKey: "achievements.tenure_days.3.description", Rewards: drops(150)},
				{Level: 4, Threshold: 365, NameKey: "achievements.tenure_days.4.name", DescriptionKey: "achievements.tenure_days.4.description", Rewards: withChest(400, 10, 1)},
			},
		},
	})
}
