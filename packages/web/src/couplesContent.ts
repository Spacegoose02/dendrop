/**
 * Built-in starters for the couples kit. Kept tasteful on purpose: anything spicier is for the
 * two of you to write yourselves, and it stays end-to-end encrypted when you do.
 */

export const STARTER_IDEAS = [
  "Breakfast in bed",
  "Slow dance in the kitchen",
  "A weekend away with no plans",
  "Massage night, taking turns",
  "Recreate our first date",
  "A candlelit bath together",
  "Stargazing with a blanket",
  "Take a class together (cooking, dancing, pottery)",
  "A whole evening with our phones off",
  "Write each other a letter to open in a year",
  "Matching outfits for a day",
  "A picnic somewhere new",
];

export interface Deck {
  name: string;
  emoji: string;
  cards: string[];
}

export const BUILTIN_DECKS: Deck[] = [
  {
    name: "Getting closer",
    emoji: "🫶",
    cards: [
      "What's a small thing I do that makes you feel loved?",
      "What's a memory of us you replay most often?",
      "What's something you've never told me about your childhood?",
      "When do you feel most like yourself with me?",
      "What's one thing you want us to do more of this year?",
      "What's a dream you've been shy about saying out loud?",
      "What did you think of me the first time we met?",
      "How can I support you better this month?",
      "What's a moment you were really proud of us?",
      "What does a perfect lazy Sunday look like for you?",
    ],
  },
  {
    name: "Flirty",
    emoji: "😘",
    cards: [
      "What's the first thing you noticed about me?",
      "Describe your ideal date night, start to finish.",
      "What's something I wear that you can't stop looking at?",
      "When did you last think about me during the day? What was it?",
      "What's your favourite way for me to greet you?",
      "Tell me a compliment you've been saving up.",
      "Where's somewhere you'd love to kiss me that we haven't?",
      "What's a song that makes you think of us?",
      "Finish this: \"I knew I liked you when…\"",
      "What should I surprise you with next?",
    ],
  },
  {
    name: "Just for fun",
    emoji: "🎲",
    cards: [
      "If we opened a restaurant, what would it serve?",
      "Which movie couple are we most like?",
      "What would our raccoon names be?",
      "What's the silliest fight we've ever had?",
      "If we won a free trip tomorrow, where are we going?",
      "What's a skill you'd want us both to learn?",
      "What would our theme song be?",
      "Who would win in a pillow fight, honestly?",
    ],
  },
];

/** Starter "would you rather" questions: [the question, option A, option B]. */
export const WOULD_YOU_RATHER: [string, string, string][] = [
  ["Would you rather…", "A cozy cabin weekend", "A beach resort weekend"],
  ["Would you rather…", "Cook dinner together", "Order in and watch a movie"],
  ["Would you rather…", "Go on a surprise date I plan", "Plan a surprise date for me"],
  ["Would you rather…", "Dance in the rain", "Watch the sunrise together"],
  ["Would you rather…", "Get a long massage", "Give a long massage"],
  ["Would you rather…", "Relive our first date", "Fast-forward to our 50th anniversary"],
  ["Would you rather…", "Love letters", "Surprise gifts"],
  ["Would you rather…", "A road trip with no map", "A trip with every minute planned"],
];

export const STARTER_SPINNER = {
  name: "Date night",
  options: ["Movie night in", "Try a new restaurant", "Game night", "Long walk and dessert", "Cook something new", "Bowling or mini golf", "Spa night at home"],
};
