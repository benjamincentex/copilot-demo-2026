// Weekly inspirational quotes for homeschool families.
// Only quotes with solid sourcing are used (many popular "education quotes" are misattributed).
// Each week of the year picks a quote by season: month + week-of-month (1–4; a 5th week reuses the 4th).

const Q = {
  einstein_joy: { q: "It is the supreme art of the teacher to awaken joy in creative expression and knowledge.", a: "Albert Einstein", t: "The joy of learning", n: "Look for one moment this week when your child lights up, and follow it." },
  einstein_curious: { q: "I have no special talents. I am only passionately curious.", a: "Albert Einstein", t: "Curiosity", n: "Let one question this week take you somewhere you didn't plan to go." },
  mason_atmosphere: { q: "Education is an atmosphere, a discipline, a life.", a: "Charlotte Mason", t: "A new school year", n: "The rhythm of your home teaches as much as any lesson plan." },
  mason_outdoors: { q: "Never be within doors when you can rightly be without.", a: "Charlotte Mason", t: "Learning outdoors", n: "Take one lesson outside this week. Central Texas weather is on your side." },
  montessori_success: { q: "The greatest sign of success for a teacher is to be able to say, 'The children are now working as if I did not exist.'", a: "Maria Montessori", t: "Independence", n: "Step back once this week and let them figure it out." },
  rogers_play: { q: "Play is often talked about as if it were a relief from serious learning. But for children, play is serious learning. Play is really the work of childhood.", a: "Fred Rogers", t: "The power of play", n: "Protect some unhurried playtime this week. It counts." },
  rogers_feelings: { q: "Anything that's human is mentionable, and anything that is mentionable can be more manageable.", a: "Fred Rogers", t: "Hard days", n: "Talk about the hard parts out loud this week. It makes them lighter." },
  seuss_read: { q: "The more that you read, the more things you will know. The more that you learn, the more places you'll go.", a: "Dr. Seuss", t: "Reading", n: "Add one extra read-aloud this week, for no reason at all." },
  dickinson_book: { q: "There is no Frigate like a Book / To take us Lands away.", a: "Emily Dickinson", t: "Adventures in books", n: "Pick a book set somewhere none of you have been." },
  holt_learning: { q: "Learning is not the product of teaching. Learning is the product of the activity of learners.", a: "John Holt", t: "Back to learning", n: "Give your kids something to do, not just something to hear." },
  plato_wonder: { q: "Wonder is the feeling of a philosopher, and philosophy begins in wonder.", a: "Plato, Theaetetus", t: "Wonder", n: "Wonder is where learning starts. Make room for 'I wonder why…'" },
  plutarch_fire: { q: "The mind is not a vessel that needs filling, but wood that needs igniting.", a: "Plutarch (paraphrased)", t: "Kindling a love of learning", n: "Spark one interest this week instead of covering one more topic." },
  alcott_storms: { q: "I am not afraid of storms, for I am learning how to sail my ship.", a: "Louisa May Alcott, Little Women", t: "Perseverance", n: "Rough weeks are part of the voyage. Keep sailing." },
  keller_together: { q: "Alone we can do so little; together we can do so much.", a: "Helen Keller", t: "Community", n: "Reach out to one homeschool family this week. You're not doing this alone." },
  cicero_gratitude: { q: "Gratitude is not only the greatest of virtues, but the parent of all the others.", a: "Cicero", t: "Gratitude", n: "Start each day this week by naming one thing you're thankful for." },
  dickens_christmas: { q: "I will honour Christmas in my heart, and try to keep it all the year.", a: "Charles Dickens, A Christmas Carol", t: "The holidays", n: "Let the season be the lesson: generosity, family, and a good story." },
  emerson_everyday: { q: "Write it on your heart that every day is the best day in the year.", a: "Ralph Waldo Emerson", t: "A fresh start", n: "Every day is a chance to start again. Today counts." },
  camus_autumn: { q: "Autumn is a second spring when every leaf is a flower.", a: "Albert Camus", t: "Autumn", n: "Collect a few fall leaves this week and let them lead a lesson." },
  camus_summer: { q: "In the midst of winter, I found there was, within me, an invincible summer.", a: "Albert Camus", t: "Winter", n: "Short days are a good time for long books and warm drinks." },
  lubbock_rest: { q: "Rest is not idleness, and to lie sometimes on the grass under trees on a summer's day, listening to the murmur of the water, or watching the clouds float across the sky, is by no means a waste of time.", a: "John Lubbock", t: "Summer rest", n: "Rest is part of learning. Enjoy a slower week." },
  travis_texas: { q: "I shall never surrender or retreat.", a: "William B. Travis, letter from the Alamo, Feb. 24, 1836", t: "Texas History Month", n: "March is Texas History Month. Visit a Texas history site this week." },
  aristotle_roots: { q: "The roots of education are bitter, but the fruit is sweet.", a: "Attributed to Aristotle", t: "Finishing strong", n: "The hard work of this year is about to bear fruit. Finish strong." },
};

// month (1–12) -> four weekly quote keys
const PLAN = {
  1: ["emerson_everyday", "einstein_curious", "alcott_storms", "seuss_read"],
  2: ["alcott_storms", "rogers_feelings", "dickinson_book", "keller_together"],
  3: ["travis_texas", "mason_outdoors", "plato_wonder", "rogers_play"],
  4: ["mason_outdoors", "einstein_curious", "rogers_play", "seuss_read"],
  5: ["aristotle_roots", "montessori_success", "cicero_gratitude", "lubbock_rest"],
  6: ["lubbock_rest", "rogers_play", "dickinson_book", "mason_outdoors"],
  7: ["plato_wonder", "lubbock_rest", "seuss_read", "plutarch_fire"],
  8: ["holt_learning", "mason_atmosphere", "einstein_joy", "emerson_everyday"],
  9: ["mason_atmosphere", "einstein_curious", "keller_together", "plutarch_fire"],
  10: ["camus_autumn", "alcott_storms", "dickinson_book", "plato_wonder"],
  11: ["cicero_gratitude", "keller_together", "einstein_joy", "cicero_gratitude"],
  12: ["camus_summer", "keller_together", "dickens_christmas", "emerson_everyday"],
};

// The week starts on Monday (Central Time). Returns { key, week, q, a, t, n }.
export function quoteForDate(date = new Date()) {
  const ct = new Date(date.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const monday = new Date(ct); monday.setDate(ct.getDate() - ((ct.getDay() + 6) % 7));
  const m = monday.getMonth() + 1, wk = Math.min(3, Math.floor((monday.getDate() - 1) / 7));
  const key = PLAN[m][wk];
  const week = `${monday.getFullYear()}-${String(m).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
  return { key, week, ...Q[key] };
}
