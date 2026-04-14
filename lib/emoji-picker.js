/**
 * TextMe — Emoji Picker
 * License: AGPL-3.0
 *
 * Features:
 *  - 9 categories with ~350 emoji
 *  - Keyword-based search (each emoji has associated search terms)
 *  - Recent emoji (localStorage, up to 24)
 *  - Toggle open/close via button
 *  - Slide-up animation on open
 *  - Inserts at cursor position in textarea
 */

// ─── Emoji data: [emoji, ...searchKeywords] ─────────────────────────────────

const CATEGORIES = {
    'Smileys': [
        ['😀','grin','happy','smile'],
        ['😃','grin','happy','open'],
        ['😄','grin','happy','smile','eyes'],
        ['😁','beaming','grin','happy'],
        ['😆','laughing','happy','haha'],
        ['😅','sweat','nervous','laugh'],
        ['🤣','rolling','laughing','lol','rofl'],
        ['😂','joy','tears','laugh','cry','lol'],
        ['🙂','slight','smile','happy'],
        ['🙃','upside','sarcastic','silly'],
        ['😊','blush','smile','happy','shy'],
        ['😇','angel','halo','innocent','sweet'],
        ['🥰','hearts','love','adore','smiling'],
        ['😍','heart eyes','love','adore'],
        ['🤩','star struck','wow','amazing','excited'],
        ['😘','kiss','love','blow'],
        ['😗','kiss','whistle'],
        ['😚','kiss','closed eyes'],
        ['😋','yum','delicious','tongue'],
        ['😛','tongue','playful'],
        ['😜','wink','tongue','crazy'],
        ['🤪','zany','crazy','wild'],
        ['😝','tongue','closed eyes','silly'],
        ['🤗','hug','warm','embrace'],
        ['🤭','oops','covering mouth','quiet'],
        ['🤫','shush','quiet','secret'],
        ['🤔','think','hmm','wonder'],
        ['🤐','zipper mouth','quiet','secret'],
        ['😐','neutral','meh','blank'],
        ['😑','expressionless','blank','meh'],
        ['😶','no mouth','silent','quiet'],
        ['😏','smirk','sly','side'],
        ['😒','unamused','annoyed','meh'],
        ['🙄','eye roll','whatever','annoyed'],
        ['😬','grimace','nervous','awkward'],
        ['😌','relieved','peaceful','calm'],
        ['😔','pensive','sad','disappointed'],
        ['😪','sleepy','tired','yawn'],
        ['🤤','drool','hungry','want'],
        ['😴','sleeping','zzz','tired'],
        ['😷','mask','sick','ill','covid'],
        ['🤒','sick','thermometer','fever','ill'],
        ['🤕','hurt','bandage','head','injured'],
        ['🤢','nausea','sick','green'],
        ['🤮','vomit','sick','gross'],
        ['🤧','sneeze','sick','tissue'],
        ['🥵','hot','overheating','fever'],
        ['🥶','cold','freezing','blue'],
        ['😱','scream','shocked','horror','scared'],
        ['😨','fearful','scared','anxious'],
        ['😰','worried','nervous','sweat'],
        ['😥','disappointed','sad','relieved'],
        ['😢','crying','sad','tear'],
        ['😭','loudly crying','sob','sad'],
        ['😤','huffing','frustrated','angry'],
        ['😠','angry','mad','frowning'],
        ['😡','rage','angry','red','furious'],
        ['🤬','swearing','angry','profanity'],
        ['😈','devil','evil','smiling','villain'],
        ['👿','angry devil','evil','pouting'],
        ['💀','skull','dead','death'],
        ['☠','skull crossbones','death','danger'],
        ['🤡','clown','silly'],
        ['👻','ghost','halloween','boo'],
        ['👽','alien','ufo','extraterrestrial'],
        ['🤖','robot','bot','ai'],
        ['💩','poop','pile','funny'],
        ['😺','cat','happy','smile'],
        ['😸','cat','grin','happy'],
        ['😹','cat','joy','laugh','tears'],
        ['😻','cat','heart eyes','love'],
        ['😼','cat','smirk','wink'],
        ['😽','cat','kiss'],
        ['🙀','cat','scream','shocked'],
        ['😿','cat','crying','sad'],
        ['😾','cat','pouting','angry'],
    ],
    'Gestures': [
        ['👋','wave','hello','hi','bye'],
        ['🤚','raised','back hand','stop'],
        ['✋','raised hand','stop','high five'],
        ['🖖','vulcan','spock','live long','prosper'],
        ['👌','ok','perfect','chef kiss'],
        ['🤌','pinched','italian','gesture'],
        ['✌','victory','peace','two'],
        ['🤞','crossed fingers','luck','hope'],
        ['🤟','love you','hand','rock'],
        ['🤘','rock on','horns','metal'],
        ['🤙','call me','shaka','hang loose'],
        ['👈','point left','back','that way'],
        ['👉','point right','next','that way'],
        ['👆','point up','above'],
        ['🖕','middle finger','rude'],
        ['👇','point down','below'],
        ['☝','index up','point','one'],
        ['👍','thumbs up','like','approve','good','yes'],
        ['👎','thumbs down','dislike','no','bad'],
        ['✊','fist','raised','punch'],
        ['👊','punch','fist','oncoming'],
        ['🤛','left fist','bump'],
        ['🤜','right fist','bump'],
        ['👏','clap','applause','bravo'],
        ['🙌','hands up','hooray','celebration'],
        ['🤲','palms up','prayer','cup'],
        ['🤝','handshake','deal','agree'],
        ['🙏','pray','please','thanks','folded hands'],
        ['✍','write','pen','sign'],
        ['💅','nail polish','sassy','done'],
        ['🤳','selfie','phone','camera'],
        ['💪','muscle','strong','flex','bicep'],
        ['🦾','mechanical arm','strong','prosthetic'],
        ['🦿','mechanical leg','prosthetic'],
        ['🦵','leg','kick'],
        ['🦶','foot','kick','sole'],
        ['👂','ear','listen','hearing'],
        ['🦻','ear with aid','hearing'],
        ['👃','nose','smell','sniff'],
        ['🧠','brain','think','smart'],
        ['👀','eyes','look','see','watch'],
        ['👁','eye','look','see'],
        ['👅','tongue','taste','lick'],
        ['🦷','tooth','teeth','dentist'],
    ],
    'Hearts': [
        ['❤','red heart','love','like'],
        ['🧡','orange heart','like'],
        ['💛','yellow heart','like'],
        ['💚','green heart','like'],
        ['💙','blue heart','like'],
        ['💜','purple heart','like'],
        ['🖤','black heart','like','dark'],
        ['🤍','white heart','pure','clean'],
        ['🤎','brown heart','warm'],
        ['💔','broken heart','heartbreak','sad'],
        ['❣','heart exclamation','love','care'],
        ['💕','two hearts','love','pink'],
        ['💞','revolving hearts','love','spin'],
        ['💓','beating heart','love','pulse'],
        ['💗','growing heart','love','pink'],
        ['💖','sparkling heart','love','glitter'],
        ['💘','heart with arrow','love','cupid'],
        ['💝','heart with ribbon','gift','love'],
        ['💟','heart decoration','love'],
        ['♥','heart suit','card','love'],
        ['😻','cat heart eyes','love','adore'],
        ['💌','love letter','mail','message'],
        ['💏','kiss','couple','love'],
        ['💑','couple heart','love','romance'],
    ],
    'People': [
        ['🧑','person','adult'],
        ['👦','boy','child','kid'],
        ['👧','girl','child','kid'],
        ['👨','man','male','adult'],
        ['👩','woman','female','adult'],
        ['🧓','older person','senior'],
        ['👴','old man','grandfather','senior'],
        ['👵','old woman','grandmother','senior'],
        ['👶','baby','infant','newborn'],
        ['🧒','child','kid','youth'],
        ['🧔','beard','man','facial hair'],
        ['👱','blonde','person','hair'],
        ['🧕','hijab','woman','headscarf'],
        ['👲','cap','man','chinese hat'],
        ['🤴','prince','crown','royal'],
        ['👸','princess','crown','royal'],
        ['🧙','mage','wizard','magic'],
        ['🧝','elf','fantasy','ears'],
        ['🧛','vampire','dracula','halloween'],
        ['🧟','zombie','undead','horror'],
        ['🧞','genie','magic','wish'],
        ['🧜','mermaid','fantasy','ocean'],
        ['🧚','fairy','fantasy','wings'],
        ['👼','angel','baby','wings','cute'],
        ['🤶','santa','mrs claus','christmas'],
        ['🎅','santa','christmas','holiday'],
        ['🦸','superhero','hero','cape'],
        ['🦹','supervillain','villain','evil'],
        ['🧑‍💻','technologist','coder','developer'],
        ['👨‍💻','man coder','developer','programmer'],
        ['👩‍💻','woman coder','developer','programmer'],
        ['🕵','detective','spy','investigate'],
        ['💃','dancing woman','dance','party'],
        ['🕺','dancing man','dance','party'],
        ['🧑‍🎤','singer','rock star','music'],
        ['🧑‍🍳','cook','chef','food'],
        ['🧑‍🚀','astronaut','space','rocket'],
        ['🧑‍🎨','artist','painter','art'],
    ],
    'Nature': [
        ['🐶','dog','puppy','pet'],
        ['🐱','cat','kitten','pet'],
        ['🐭','mouse','rodent'],
        ['🐹','hamster','pet','cute'],
        ['🐰','rabbit','bunny','cute'],
        ['🦊','fox','sly'],
        ['🐻','bear','animal','cute'],
        ['🐼','panda','cute'],
        ['🐨','koala','cute','australia'],
        ['🐯','tiger','stripe','wild'],
        ['🦁','lion','wild','king'],
        ['🐮','cow','moo','farm'],
        ['🐷','pig','farm','oink'],
        ['🐸','frog','green','jump'],
        ['🐵','monkey','ape','banana'],
        ['🐔','chicken','bird','farm'],
        ['🐧','penguin','bird','cold'],
        ['🐦','bird','tweet','fly'],
        ['🦅','eagle','bird','fly'],
        ['🦆','duck','quack','water'],
        ['🦋','butterfly','pretty','fly'],
        ['🐛','bug','caterpillar','insect'],
        ['🐝','bee','honey','insect'],
        ['🐞','ladybug','insect','red'],
        ['🦎','lizard','reptile'],
        ['🐍','snake','reptile','danger'],
        ['🐢','turtle','slow','shell'],
        ['🐙','octopus','tentacles','ocean'],
        ['🦑','squid','ocean','tentacles'],
        ['🦀','crab','red','ocean'],
        ['🦞','lobster','red','ocean'],
        ['🐡','blowfish','ocean','puffer'],
        ['🐠','fish','tropical','ocean'],
        ['🐟','fish','water','swim'],
        ['🐬','dolphin','ocean','smart'],
        ['🐳','whale','ocean','big'],
        ['🐋','whale','ocean','big'],
        ['🦈','shark','danger','ocean'],
        ['🌸','cherry blossom','flower','pink','spring'],
        ['💐','bouquet','flower','gift'],
        ['🌹','rose','flower','love','red'],
        ['🌺','hibiscus','flower','tropical'],
        ['🌻','sunflower','bright','yellow'],
        ['🌼','blossom','flower','yellow'],
        ['🌷','tulip','flower','pink'],
        ['🌱','seedling','plant','grow','sprout'],
        ['🌲','tree','evergreen','forest'],
        ['🌳','tree','deciduous','nature'],
        ['🌴','palm tree','tropical','beach'],
        ['🍀','four leaf clover','luck','green'],
        ['🍁','maple leaf','canada','autumn','fall'],
        ['🍂','fallen leaf','autumn','fall'],
        ['🍃','leaf','green','blow'],
        ['☀','sun','sunny','bright','warm'],
        ['🌤','sun','cloud','partly'],
        ['⛅','cloud','sun','partly'],
        ['🌧','rain','cloud','wet'],
        ['🌩','storm','lightning','rain'],
        ['🌨','snow','cloud','cold','winter'],
        ['❄','snowflake','cold','winter','ice'],
        ['⛄','snowman','winter','cold'],
        ['🌈','rainbow','colorful','after rain'],
        ['🌊','wave','ocean','surf','water'],
        ['🔥','fire','hot','flame','lit'],
        ['💧','drop','water','liquid'],
        ['💦','water','splash','sweat'],
        ['🌙','moon','night','crescent'],
        ['⭐','star','shine','yellow'],
        ['✨','sparkles','shine','magic','glitter'],
        ['🌟','glowing star','shine','bright'],
        ['💫','dizzy','star','spin'],
        ['☄','comet','meteor','space'],
        ['🌍','earth','globe','world','europe','africa'],
        ['🌎','earth','globe','world','americas'],
        ['🌏','earth','globe','world','asia'],
    ],
    'Food': [
        ['🍎','apple','red','fruit'],
        ['🍊','orange','citrus','fruit'],
        ['🍋','lemon','citrus','sour','yellow'],
        ['🍌','banana','yellow','fruit'],
        ['🍉','watermelon','summer','red'],
        ['🍇','grapes','purple','fruit'],
        ['🍓','strawberry','red','berry'],
        ['🫐','blueberry','berry','small'],
        ['🍒','cherries','red','sweet'],
        ['🍑','peach','soft','fruit'],
        ['🥭','mango','tropical','fruit'],
        ['🍍','pineapple','tropical','fruit'],
        ['🥥','coconut','tropical'],
        ['🥑','avocado','healthy','green'],
        ['🍆','eggplant','purple','vegetable'],
        ['🥦','broccoli','green','healthy','vegetable'],
        ['🌽','corn','yellow','ear','vegetable'],
        ['🌶','chili pepper','hot','spicy','red'],
        ['🍕','pizza','italian','slice'],
        ['🍔','burger','hamburger','fast food'],
        ['🍟','fries','french fries','fast food'],
        ['🌮','taco','mexican','food'],
        ['🌯','burrito','wrap','mexican'],
        ['🥗','salad','healthy','green','bowl'],
        ['🍣','sushi','japanese','fish','rice'],
        ['🍜','noodle','ramen','soup','noodles'],
        ['🍝','spaghetti','pasta','italian'],
        ['🍦','ice cream','soft','sweet','dessert'],
        ['🍰','cake','slice','sweet','birthday'],
        ['🎂','birthday cake','celebrate','candles'],
        ['🍩','donut','sweet','dessert','hole'],
        ['🍪','cookie','sweet','chocolate chip'],
        ['🍫','chocolate','sweet','bar'],
        ['🍬','candy','sweet','lollipop'],
        ['🍭','lollipop','candy','sweet','rainbow'],
        ['🍿','popcorn','movie','snack'],
        ['☕','coffee','hot','drink','cafe'],
        ['🍵','tea','hot','drink','cup'],
        ['🧋','bubble tea','boba','drink','taiwanese'],
        ['🥤','cup','straw','soda','drink'],
        ['🧃','juice','box','drink'],
        ['🍺','beer','mug','drink','cheers'],
        ['🍻','beers','cheers','celebrate','drink'],
        ['🍷','wine','glass','drink','red'],
        ['🥂','champagne','toast','celebrate'],
        ['🍸','cocktail','drink','glass'],
        ['🥃','tumbler','whiskey','drink'],
        ['🍹','tropical drink','cocktail','summer'],
    ],
    'Activities': [
        ['⚽','soccer','football','sport'],
        ['🏀','basketball','sport','ball'],
        ['🏈','american football','sport','ball'],
        ['⚾','baseball','sport','ball'],
        ['🎾','tennis','sport','ball'],
        ['🏐','volleyball','sport','ball'],
        ['🏉','rugby','sport','ball'],
        ['🏓','ping pong','table tennis','sport'],
        ['🎱','pool','billiards','8 ball'],
        ['⛳','golf','hole','sport'],
        ['🎮','video game','controller','gaming','play'],
        ['🕹','joystick','game','play','arcade'],
        ['🎲','dice','game','roll','luck'],
        ['🎯','bullseye','target','dart','aim'],
        ['🎨','art','palette','painting','creative'],
        ['🖌','paintbrush','art','paint'],
        ['✏','pencil','write','draw','edit'],
        ['🎬','clapper','film','movie','scene'],
        ['🎤','microphone','sing','karaoke','voice'],
        ['🎧','headphones','music','listen'],
        ['🎵','music note','song','audio'],
        ['🎶','music notes','song','melody'],
        ['🎸','guitar','rock','music','instrument'],
        ['🎹','piano','keyboard','music','instrument'],
        ['🥁','drums','beat','music','instrument'],
        ['🎺','trumpet','music','instrument','brass'],
        ['🎻','violin','music','instrument','strings'],
        ['🎤','mic','sing','voice','perform'],
        ['🏆','trophy','win','award','champion','gold'],
        ['🥇','gold medal','first','win','champion'],
        ['🥈','silver medal','second'],
        ['🥉','bronze medal','third'],
        ['🎖','medal','award','honor'],
        ['🎗','ribbon','awareness','badge'],
        ['🎟','ticket','event','admit'],
        ['🎫','ticket','pass','admit'],
        ['🎠','carousel','ride','fun'],
        ['🎡','ferris wheel','park','ride','fun'],
        ['🎢','roller coaster','ride','thrill'],
        ['🎪','circus','tent','event'],
        ['🤸','gymnastics','cartwheel','sport','flip'],
        ['⛹','basketball','sport','ball'],
        ['🤺','fencing','sport','sword'],
        ['🏋','weightlifting','sport','strong','gym'],
        ['🚴','cycling','bike','sport','ride'],
        ['🤼','wrestling','sport','fight'],
        ['🤾','handball','sport','throw'],
        ['🏌','golf','swing','sport'],
        ['🏇','horse racing','sport','jockey'],
        ['🧘','meditation','yoga','zen','peace','lotus'],
        ['🛹','skateboard','skate','sport','trick'],
        ['🏄','surfing','wave','ocean','sport'],
        ['🤽','water polo','swim','sport'],
        ['🧗','climbing','sport','rock'],
        ['🤿','diving','snorkel','underwater','swim'],
        ['🎿','ski','snow','winter','sport'],
        ['🏂','snowboard','snow','winter','sport'],
        ['🪂','parachute','skydive','jump','fall'],
    ],
    'Objects': [
        ['📱','phone','mobile','call','text'],
        ['💻','laptop','computer','work'],
        ['🖥','desktop','computer','screen','monitor'],
        ['⌨','keyboard','type','computer'],
        ['🖱','mouse','click','computer'],
        ['📷','camera','photo','picture'],
        ['📸','camera flash','photo','selfie'],
        ['📹','video','camera','record'],
        ['🎥','movie','camera','film','record'],
        ['📺','tv','television','watch'],
        ['📻','radio','listen','broadcast'],
        ['⌚','watch','time','wrist'],
        ['⏰','alarm clock','wake up','time'],
        ['⏳','hourglass','time','sand','wait'],
        ['⌛','hourglass','time','sand','done'],
        ['📡','satellite','antenna','signal','space'],
        ['🔋','battery','charge','power'],
        ['🔌','plug','power','electric'],
        ['💡','light bulb','idea','bright'],
        ['🔦','flashlight','torch','light'],
        ['🕯','candle','light','flame'],
        ['🪔','diya lamp','light','fire'],
        ['📖','book','read','open'],
        ['📚','books','read','study','library'],
        ['📝','memo','note','write'],
        ['✏','pencil','write','draw'],
        ['📌','pushpin','mark','location'],
        ['📍','round pushpin','location','pin','map'],
        ['🗂','card divider','organize','folder'],
        ['📁','folder','file','organize'],
        ['📂','open folder','file'],
        ['📊','chart','bar','stats','analytics'],
        ['📈','chart up','growth','trending'],
        ['📉','chart down','falling'],
        ['💌','love letter','mail','message','heart'],
        ['📧','email','mail','message','envelope'],
        ['📨','incoming','mail','message'],
        ['📩','envelope','mail','message'],
        ['📬','mailbox','open','mail'],
        ['🔑','key','lock','access'],
        ['🗝','old key','lock','vintage'],
        ['🔒','locked','secure','private'],
        ['🔓','unlocked','open','access'],
        ['🔐','locked key','secure'],
        ['🚪','door','enter','exit'],
        ['🪟','window','glass','view'],
        ['🛋','couch','sofa','sit','relax'],
        ['🪑','chair','sit'],
        ['🚽','toilet','bathroom'],
        ['🚿','shower','bath','clean'],
        ['🛁','bathtub','bath','relax'],
        ['💰','money bag','rich','cash'],
        ['💳','credit card','pay','bank'],
        ['💎','gem','diamond','jewelry','valuable'],
        ['🎁','gift','present','wrap','birthday'],
        ['🎀','ribbon','bow','cute'],
        ['🎉','party popper','celebrate','confetti'],
        ['🎊','confetti','celebrate','party'],
        ['🎈','balloon','party','celebrate'],
        ['✉','envelope','mail','letter'],
        ['📦','package','box','delivery','ship'],
        ['🗑','trash','delete','bin','waste'],
        ['🔧','wrench','fix','tool','repair'],
        ['🔨','hammer','tool','build'],
        ['⚙','gear','settings','mechanism'],
        ['🪛','screwdriver','tool','fix'],
        ['🧲','magnet','attract','pull'],
        ['🔬','microscope','science','lab','research'],
        ['🔭','telescope','space','star','look'],
        ['🧪','test tube','science','lab','experiment'],
        ['💊','pill','medicine','drug','health'],
        ['🩺','stethoscope','doctor','health','medical'],
        ['🩹','bandage','heal','wound','fix'],
        ['🧴','lotion','bottle','skin care'],
        ['🧷','safety pin','sewing','attach'],
        ['🧹','broom','sweep','clean'],
        ['🧺','basket','laundry','carry'],
        ['🧻','roll','toilet paper','tissue'],
        ['🧼','soap','clean','wash','hygiene'],
        ['🪥','toothbrush','clean','teeth'],
        ['🧽','sponge','clean','wash'],
        ['🪣','bucket','water','clean'],
    ],
    'Symbols': [
        ['💥','collision','explosion','bang','boom'],
        ['✨','sparkles','shine','glitter','magic'],
        ['🌟','glowing','star','bright'],
        ['💫','dizzy','star','spin'],
        ['⚡','lightning','zap','fast','electric'],
        ['🔥','fire','hot','flame','lit'],
        ['❗','exclamation','important','alert'],
        ['❓','question','ask','confused'],
        ['‼','double exclamation','important'],
        ['⁉','exclamation question','confused'],
        ['💯','hundred','perfect','100'],
        ['✅','check mark','done','correct','ok'],
        ['❌','cross','no','wrong','cancel'],
        ['⭕','circle','ok','correct'],
        ['🔴','red circle','stop','alert'],
        ['🟠','orange circle'],
        ['🟡','yellow circle'],
        ['🟢','green circle','go','ok'],
        ['🔵','blue circle'],
        ['🟣','purple circle'],
        ['⚫','black circle'],
        ['⚪','white circle'],
        ['🔶','orange diamond','large'],
        ['🔷','blue diamond','large'],
        ['🔸','orange diamond','small'],
        ['🔹','blue diamond','small'],
        ['🔺','red triangle up'],
        ['🔻','red triangle down'],
        ['♾','infinity','forever','loop'],
        ['✔','check','done','correct','tick'],
        ['➕','plus','add','more'],
        ['➖','minus','subtract','less'],
        ['➗','divide','division','math'],
        ['✖','multiply','times','cross','math'],
        ['🆗','ok','approved'],
        ['🆕','new'],
        ['🆙','up'],
        ['🆒','cool'],
        ['🆓','free'],
        ['🆖','ng'],
        ['🅰','blood type','letter a'],
        ['🅱','blood type','letter b'],
        ['🆎','ab','blood type'],
        ['🅾','blood type o','letter'],
        ['🆑','cl'],
        ['🔔','bell','notification','alert','ring'],
        ['🔕','bell off','mute','silent'],
        ['🔊','loud','speaker','volume'],
        ['🔇','mute','speaker','silent'],
        ['📢','loudspeaker','announce','megaphone'],
        ['📣','megaphone','cheer','loud'],
        ['🔈','speaker','volume','low'],
        ['⚠','warning','caution','alert'],
        ['🚫','no','forbidden','ban','prohibited'],
        ['⛔','no entry','stop','forbidden'],
        ['🚷','no pedestrians'],
        ['🚯','no littering'],
        ['📵','no phones'],
        ['🔞','no under 18','adult'],
        ['🔏','locked with pen','sign'],
        ['♻','recycle','green','eco','environment'],
        ['🏷','label','tag','price'],
        ['🔖','bookmark','save','mark'],
        ['💤','zzz','sleep','tired','quiet'],
        ['💬','speech bubble','comment','chat','message'],
        ['💭','thought bubble','think','idea'],
        ['🗯','right anger bubble','rage','shout'],
        ['👁‍🗨','eye speech bubble','see','watch'],
    ],
};

// Flat array: [[emoji, keyword1, keyword2, ...], ...]
const ALL_EMOJI = Object.values(CATEGORIES).flat();

const RECENT_KEY = 'textme_recent_emojis';
const MAX_RECENT = 24;

// Category display icon (first emoji of each)
const CAT_ICONS = Object.fromEntries(
    Object.entries(CATEGORIES).map(([cat, items]) => [cat, items[0][0]])
);

let pickerEl = null;
let onSelectCallback = null;
let _triggerBtn = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Toggle the emoji picker.
 * If already open — close it. If closed — open above anchorEl.
 * @param {HTMLElement} anchorEl  — button that triggered the picker
 * @param {Function}    onSelect  — called with the selected emoji string
 */
export function openEmojiPicker(anchorEl, onSelect) {
    if (pickerEl) {
        closeEmojiPicker();
        return;
    }
    _triggerBtn = anchorEl;
    onSelectCallback = onSelect;

    pickerEl = document.createElement('div');
    pickerEl.className = 'textme-emoji-picker';

    // Search input
    const searchInput = document.createElement('input');
    searchInput.className   = 'textme-emoji-search';
    searchInput.placeholder = 'Search emoji…';
    searchInput.type        = 'text';
    searchInput.setAttribute('autocomplete', 'off');
    pickerEl.appendChild(searchInput);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'textme-emoji-tabs';

    const catNames = ['Recent', ...Object.keys(CATEGORIES)];
    catNames.forEach((cat, i) => {
        const tab = document.createElement('button');
        tab.className   = `textme-emoji-tab${i === 0 ? ' active' : ''}`;
        tab.textContent = cat === 'Recent' ? '🕐' : CAT_ICONS[cat];
        tab.title       = cat;
        tab.dataset.cat = cat;
        tab.addEventListener('click', () => {
            tabBar.querySelectorAll('.textme-emoji-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            searchInput.value = '';
            showCategory(grid, cat);
        });
        tabBar.appendChild(tab);
    });
    pickerEl.appendChild(tabBar);

    // Grid
    const grid = document.createElement('div');
    grid.className = 'textme-emoji-grid';
    pickerEl.appendChild(grid);

    showCategory(grid, 'Recent');

    // Search
    searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim();
        if (!q) {
            const active = tabBar.querySelector('.textme-emoji-tab.active');
            showCategory(grid, active?.dataset.cat || 'Recent');
        } else {
            showSearchResults(grid, q);
        }
    });

    // Mount inside phone container
    const phoneEl = document.getElementById('textme-phone');
    const container = phoneEl || document.body;
    container.appendChild(pickerEl);

    // Position above anchor
    const anchorRect    = anchorEl.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    pickerEl.style.position = 'absolute';
    pickerEl.style.bottom   = `${containerRect.bottom - anchorRect.top + 6}px`;
    pickerEl.style.left     = '8px';
    pickerEl.style.right    = '8px';

    // Animate in
    requestAnimationFrame(() => pickerEl?.classList.add('textme-emoji-picker--open'));

    // Close on outside click (delayed to avoid immediate close)
    setTimeout(() => {
        document.addEventListener('click', _handleOutsideClick);
    }, 10);

    searchInput.focus();
}

export function closeEmojiPicker() {
    if (!pickerEl) return;
    const el = pickerEl;
    el.classList.remove('textme-emoji-picker--open');
    // Wait for slide-down animation then remove
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    // Fallback in case transition doesn't fire
    setTimeout(() => { if (el.parentNode) el.remove(); }, 250);
    pickerEl = null;
    document.removeEventListener('click', _handleOutsideClick);
    onSelectCallback = null;
    _triggerBtn = null;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function showCategory(grid, category) {
    grid.innerHTML = '';
    let entries;
    if (category === 'Recent') {
        const recent = _getRecent();
        if (recent.length === 0) {
            grid.innerHTML = '<div class="textme-emoji-empty">No recent emoji yet</div>';
            return;
        }
        // Recent stores just emoji strings; wrap into [emoji] arrays for _renderButtons
        entries = recent.map(e => [e]);
    } else {
        entries = CATEGORIES[category] || [];
    }
    _renderButtons(grid, entries);
}

function showSearchResults(grid, query) {
    grid.innerHTML = '';
    const q = query.toLowerCase();
    // Match emoji whose keywords (indices 1+) or category name include the query
    const results = [];
    const seen = new Set();
    for (const [cat, items] of Object.entries(CATEGORIES)) {
        const catMatch = cat.toLowerCase().includes(q);
        for (const entry of items) {
            const emoji = entry[0];
            if (seen.has(emoji)) continue;
            // Check keywords (entry[1], entry[2], ...)
            const keywordMatch = entry.slice(1).some(kw => kw.includes(q));
            if (catMatch || keywordMatch) {
                results.push(entry);
                seen.add(emoji);
            }
        }
    }
    if (results.length === 0) {
        grid.innerHTML = '<div class="textme-emoji-empty">No results for "' + _escapeHtml(query) + '"</div>';
        return;
    }
    _renderButtons(grid, results);
}

function _renderButtons(grid, entries) {
    // Render all buttons in a wrapping flex container
    const row = document.createElement('div');
    row.className = 'textme-emoji-row';
    for (const entry of entries) {
        const emoji = entry[0];
        const title = entry.length > 1 ? entry.slice(1).join(', ') : emoji;
        const btn = document.createElement('button');
        btn.className   = 'textme-emoji-btn';
        btn.textContent = emoji;
        btn.title       = title;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            _addToRecent(emoji);
            if (onSelectCallback) onSelectCallback(emoji);
            closeEmojiPicker();
        });
        row.appendChild(btn);
    }
    grid.appendChild(row);
}

function _getRecent() {
    try {
        const s = localStorage.getItem(RECENT_KEY);
        return s ? JSON.parse(s) : [];
    } catch { return []; }
}

function _addToRecent(emoji) {
    try {
        let r = _getRecent().filter(e => e !== emoji);
        r.unshift(emoji);
        if (r.length > MAX_RECENT) r = r.slice(0, MAX_RECENT);
        localStorage.setItem(RECENT_KEY, JSON.stringify(r));
    } catch { /* ignore */ }
}

function _handleOutsideClick(e) {
    if (!pickerEl) return;
    // Don't close if clicking the trigger button (openEmojiPicker handles toggle)
    if (_triggerBtn && _triggerBtn.contains(e.target)) return;
    if (!pickerEl.contains(e.target)) {
        closeEmojiPicker();
    }
}

function _escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
