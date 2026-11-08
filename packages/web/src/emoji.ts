/** Built-in emoji for the picker and reactions, in sections, each with words to search by. */
export interface BuiltinEmoji {
  e: string;
  /** Names and words it's found by, the first being its name (":thumbs_up:"). */
  n: string[];
}

const S = (list: string): BuiltinEmoji[] =>
  list
    .trim()
    .split("\n")
    .map((line) => {
      const [e, ...n] = line.trim().split(/\s+/);
      return { e: e!, n };
    });

export const EMOJI_SECTIONS: { name: string; icon: string; emoji: BuiltinEmoji[] }[] = [
  {
    name: "Smileys",
    icon: "😀",
    emoji: S(`
      😀 grinning smile happy
      😃 smiley happy
      😄 smile happy
      😁 grin
      😆 laughing
      😅 sweat_smile phew
      😂 joy laughing tears lol
      🤣 rofl rolling lol
      🥹 holding_back_tears touched
      😊 blush happy
      😇 innocent angel halo
      🙂 slight_smile
      🙃 upside_down
      😉 wink
      😌 relieved
      😍 heart_eyes love
      🥰 smiling_hearts love
      😘 kiss
      😋 yum tasty
      😛 tongue
      😜 winking_tongue silly
      🤪 zany crazy silly
      🤓 nerd
      😎 sunglasses cool
      🥳 party celebrate
      🤩 star_struck wow
      🤔 thinking hmm
      🤨 raised_eyebrow sus
      😐 neutral meh
      😑 expressionless
      😶 no_mouth
      🙄 eye_roll
      😏 smirk
      😬 grimace yikes
      🫠 melting
      🤗 hug
      🤭 hand_over_mouth oops
      🫡 salute
      🤫 shush quiet
      😴 sleeping tired zzz
      🥱 yawn tired
      😪 sleepy
      🤤 drool
      😷 mask sick
      🤒 thermometer sick
      🤢 nauseated gross
      🤮 vomit gross
      🥵 hot
      🥶 cold freezing
      😵 dizzy
      🤯 mind_blown exploding
      🤠 cowboy
      😕 confused
      😟 worried
      🙁 frown sad
      😮 open_mouth wow
      😲 astonished shocked
      😳 flushed embarrassed
      🥺 pleading puppy_eyes
      😢 cry sad tear
      😭 sob crying
      😱 scream scared
      😖 confounded
      😤 huff triumph
      😡 rage angry mad
      😠 angry mad
      🤬 cursing
      😈 smiling_imp devil
      💀 skull dead
      💩 poop
      🤡 clown
      👻 ghost boo
      👽 alien
      🤖 robot
    `),
  },
  {
    name: "People",
    icon: "👍",
    emoji: S(`
      👍 thumbs_up yes like +1
      👎 thumbs_down no dislike -1
      👏 clap applause
      🙌 raised_hands yay
      🙏 pray please thanks
      💪 muscle strong flex
      👋 wave hi hello bye
      🤞 crossed_fingers luck
      ✌️ peace victory
      🤟 love_you
      🤘 rock_on metal
      👌 ok_hand perfect
      🤌 pinched_fingers
      👈 point_left
      👉 point_right
      👆 point_up
      👇 point_down
      ☝️ index_up
      ✋ raised_hand stop
      🤚 back_of_hand
      🖐️ hand_splayed
      🫶 heart_hands love
      🤝 handshake deal
      ✊ fist
      👊 punch fist_bump
      🫵 point_at_you
      👀 eyes look
      🧠 brain smart
      🫂 people_hugging hug
      👶 baby
      🧒 child kid
      👦 boy
      👧 girl
      🧑 person
      👨 man
      👩 woman
      👴 grandpa old_man
      👵 grandma old_woman
      👪 family
      🤷 shrug idk
      🤦 facepalm
      🙋 raising_hand me
      🙇 bow
      💃 dancer dance
      🕺 man_dancing dance
      🏃 running run
    `),
  },
  {
    name: "Animals",
    icon: "🦝",
    emoji: S(`
      🦝 raccoon trash_panda
      🐾 paw_prints
      🐶 dog puppy
      🐱 cat kitty
      🐭 mouse
      🐹 hamster
      🐰 rabbit bunny
      🦊 fox
      🐻 bear
      🐼 panda
      🐨 koala
      🐯 tiger
      🦁 lion
      🐮 cow
      🐷 pig
      🐸 frog
      🐵 monkey
      🙈 see_no_evil
      🙉 hear_no_evil
      🙊 speak_no_evil
      🐔 chicken
      🐧 penguin
      🐦 bird
      🦆 duck
      🦉 owl
      🦇 bat
      🐺 wolf
      🦄 unicorn
      🐝 bee
      🐛 bug
      🦋 butterfly
      🐌 snail
      🐢 turtle
      🐍 snake
      🦖 t_rex dinosaur
      🐙 octopus
      🦀 crab
      🐠 fish
      🐬 dolphin
      🐳 whale
      🦈 shark
      🦔 hedgehog
      🦦 otter
      🦥 sloth
      🌲 tree evergreen
      🌵 cactus
      🌸 cherry_blossom flower
      🌻 sunflower
      🌈 rainbow
      ☀️ sun sunny
      🌙 moon night
      ⭐ star
      ⚡ zap lightning
      ❄️ snowflake snow cold
      🔥 fire lit hot
      💧 droplet water
      🌊 wave ocean
    `),
  },
  {
    name: "Food",
    icon: "🍕",
    emoji: S(`
      🍕 pizza
      🍔 burger hamburger
      🍟 fries
      🌭 hotdog
      🌮 taco
      🌯 burrito
      🍿 popcorn
      🥨 pretzel
      🧀 cheese
      🥞 pancakes
      🧇 waffle
      🥓 bacon
      🍳 egg cooking
      🍝 spaghetti pasta
      🍜 ramen noodles
      🍣 sushi
      🍩 donut doughnut
      🍪 cookie
      🎂 birthday_cake
      🍰 cake
      🧁 cupcake
      🍫 chocolate
      🍬 candy
      🍭 lollipop
      🍦 ice_cream
      🍎 apple
      🍌 banana
      🍉 watermelon
      🍓 strawberry
      🍇 grapes
      🥑 avocado
      🥕 carrot
      🌽 corn
      ☕ coffee
      🍵 tea
      🥤 soda cup
      🧃 juice_box
      🥛 milk
    `),
  },
  {
    name: "Activities",
    icon: "🎮",
    emoji: S(`
      🎮 video_game controller gaming
      🕹️ joystick arcade
      🎲 dice game
      🧩 puzzle
      ♟️ chess
      🎯 bullseye target
      🎳 bowling
      ⚽ soccer football
      🏀 basketball
      🏈 american_football
      ⚾ baseball
      🎾 tennis
      🏐 volleyball
      🏓 ping_pong
      🏆 trophy win
      🥇 gold_medal first
      🎉 tada party celebrate
      🎊 confetti
      🎈 balloon
      🎁 gift present
      🎄 christmas_tree
      🎃 jack_o_lantern halloween
      🎵 music note
      🎶 notes music
      🎤 microphone sing
      🎧 headphones
      🎸 guitar
      🎨 art paint
      🎬 movie clapper
      📺 tv television
      📚 books read
      ✏️ pencil
      🏕️ camping
      🚗 car
      🚲 bike bicycle
      ✈️ airplane travel
      🚀 rocket launch
      🏠 house home
      🏫 school
    `),
  },
  {
    name: "Symbols",
    icon: "❤️",
    emoji: S(`
      ❤️ heart love red_heart
      🧡 orange_heart
      💛 yellow_heart
      💚 green_heart
      💙 blue_heart
      💜 purple_heart
      🖤 black_heart
      🤍 white_heart
      🤎 brown_heart
      💔 broken_heart
      💕 two_hearts
      💖 sparkling_heart
      💯 100 hundred perfect
      ✨ sparkles
      💥 boom
      💤 zzz sleep
      💬 speech_bubble
      💭 thought_bubble
      ❗ exclamation
      ❓ question
      ‼️ bangbang
      ✅ check yes done
      ❌ x no cross
      ⭕ circle
      🚫 no_entry forbidden
      ⚠️ warning
      🆗 ok
      🆕 new
      🔔 bell notification
      🔒 lock
      🔑 key
      💡 idea bulb
      📌 pin
      📷 camera photo
      📱 phone
      💻 laptop computer
      ⏰ alarm clock
      ⏳ hourglass waiting
      💰 money
      🗑️ trash wastebasket
      🏳️‍🌈 rainbow_flag pride
      🏁 checkered_flag finish
    `),
  },
];

/** Every built-in emoji, for search. */
export const ALL_EMOJI: BuiltinEmoji[] = EMOJI_SECTIONS.flatMap((s) => s.emoji);

/** Quick reactions offered first. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🦝"];

/** The built-in emoji called `name` (":thumbs_up:" without the colons), if there is one. */
export const builtinByName = (name: string): string | undefined => ALL_EMOJI.find((x) => x.n[0] === name.toLowerCase())?.e;
