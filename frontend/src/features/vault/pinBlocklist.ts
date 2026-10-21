// Blocklist IT/EN per la policy del PIN: nomi, parole comuni e password tipiche
// (parole di 4-5 lettere piu i prefissi di 4 e 5 lettere di quelle piu lunghe).
// Chunk separato: caricato solo con import() da PinPolicy.ts.

const RAW = `
marco luca paolo mario anna sara giulia chiara elena laura maria franca luigi carlo andrea
matteo simone davide fabio enzo gino toni nico dario diego mirko pietro piero ivan nick
alex alessandro giorgio giovanni stefano stefania silvia sonia sofia marta marina monica
nadia nancy nina nora olga omar otto pablo paola patty rita rosa rocco rosy ruby sami
sandy saul sean sere serena sergio tina tito tom toby ugo vale vera vito vera yuri zoe
zeno aldo alba alice amos anto ariel arturo asia ava ben bea beppe bruno carla carmen
cesare cinzia clara clelia dani dina dino dora edoardo edo elisa ella emma enea enrico
erica ester eva ezio fabia fausto fede felice fiona fiore flavia fosca franco frank gabri
gaia gemma gianni gigi gina gioia gloria guido gwen hans hugo ilaria irene iris isa
jack jade jake james jane jean jeff jenny jim joe john jose judy julia karen kate katia
ken kevin kim kurt lara larry lea leo leon leone lia lidia lina lisa livia lola lorenzo
lori lou lucia luisa lupo lydia manu manuel mara marc margo mark martin mary mauro max
mia mike mila mimi mina mira moira monia nando nanni neri nick nico nino noemi nora
orso oscar pam pat paul pedro pepe peter pia pina pino rafa raul remo renzo rick
rino rob robert roby rodolfo rolf romeo romina ron rosso rudy sabina sally sam samuel
sasha silvio simona sole stella susan tania tea teo teresa tess tiziano tony ugo
ulisse uma valeria vanda vanni vera vico vida viola vivi walter will willy
zara zita zeta

casa ciao amore mamma papa pap nonno nonna figlio figli sole luna mare cielo terra fuoco
acqua aria vento neve pioggia nuvola stella notte giorno sera mattina oggi ieri domani
tempo anno mese ora minuto secondo lunedi martedi mercoledi giovedi venerdi sabato
domenica gennaio febbraio marzo aprile maggio giugno luglio agosto settembre ottobre
novembre dicembre estate inverno autunno primavera caldo freddo bello brutto grande
piccolo nuovo vecchio alto basso lungo corto forte debole veloce lento facile difficile
buono cattivo felice triste vero falso giusto sbagliato pieno vuoto aperto chiuso
bianco nero rosso verde giallo blu azzurro viola rosa grigio marrone arancio oro argento
uno due tre quattro cinque sei sette otto nove dieci cento mille primo prima ultimo
sempre mai forse molto poco tanto troppo ancora gia dopo prima sopra sotto dentro fuori
avanti dietro destra sinistra centro nord sud est ovest italia roma milano napoli torino
firenze venezia bologna genova palermo bari verona padova trieste parma modena siena
pisa lecce trento bolzano cagliari catania messina brescia bergamo como varese monza
lucca prato ancona perugia terni rimini ravenna ferrara pavia cremona mantova udine
vicenza treviso asti cuneo novara aosta savona imola latina rieti viterbo sicilia
sardegna puglia lazio veneto toscana umbria marche calabria abruzzo molise liguria
campania basilicata lombardia piemonte friuli emilia europa mondo paese citta strada
piazza via viale corso ponte porto monte colle valle lago fiume mare isola spiaggia
campo prato bosco albero fiore fiori rosa giglio pianta foglia frutta mela pera uva
fico limone arancia banana pesca fragola ciliegia pane pasta pizza riso carne pesce
latte uovo uova burro olio sale zucchero caffe vino birra acqua succo torta gelato
dolce panino salame prosciutto formaggio insalata pomodoro patata carota cipolla aglio
cane gatto topo cavallo mucca maiale pecora capra gallo gallina uccello aquila leone
tigre orso lupo volpe lepre coniglio pesce balena delfino squalo rana serpente drago
ragno ape farfalla formica scuola classe libro libri penna carta matita banco lavoro
ufficio azienda ditta socio capo cliente conto banco banca soldi euro prezzo costo
spesa negozio mercato vendita acquisto dati posta mail email codice numero nome cognome
parola frase testo nota note appunti idea idee piano piani lista cose cosa tutto niente
nulla qualcosa qualche ogni alcuni altro altra altri stesso stessa mondo vita morte
amico amica amici fratello sorella padre madre zio zia cugino cugina marito moglie
sposo sposa bimbo bimba bambino ragazzo ragazza uomo donna gente persona signore
signora dottore dottor prof professore maestro maestra medico avvocato ingegnere
juventus inter milan roma lazio napoli toro samp genoa fiorentina atalanta torino
ferrari fiat lancia vespa alfa maserati lamborghini ducati pirelli barilla nutella
password passwd passw parola chiave segreto segreta privato privata pubblico accesso
entra entrare esci uscire apri chiudi salva invia vai ciaone forza evviva grazie prego
scusa bravo brava bene male meglio peggio mio mia miei tuo tua suo sua nostro vostro
io tu lui lei noi voi loro che chi come dove quando perche quanto quale cosa

love hate life live dead death born hope wish dream dreams happy sad fun joy peace war
home house room door wall roof floor window garden yard street road city town village
country world earth sun moon star stars sky cloud rain snow wind storm fire ice water
air sea ocean river lake mountain hill rock stone sand tree wood forest leaf flower
rose lily grass plant fruit apple pear peach grape lemon orange banana berry cherry
bread milk cheese butter egg eggs meat beef pork chicken fish rice pasta pizza salad
soup cake candy sugar salt pepper honey juice coffee tea beer wine whisky vodka drink
food eat dinner lunch break supper snack dog cat bird fish horse cow pig sheep goat
duck bear lion tiger wolf fox deer rabbit mouse rat snake frog bee ant spider monkey
whale shark eagle hawk owl crow dragon unicorn man woman boy girl baby child kid kids
mom mum mother dad father son daughter brother sister uncle aunt wife husband friend
buddy mate pal boss king queen prince princess lord lady knight sir miss mister
hero super batman superman spider spiderman ironman hulk thor joker robin flash
star wars trek jedi sith yoda vader luke leia han solo harry potter ron hermione
frodo gandalf bilbo sauron mario luigi zelda link pokemon pikachu sonic naruto goku
dragon ball zelda game games play player gamer win winner lose loser score level
football soccer tennis golf hockey rugby boxing chess poker cards dice lotto lucky
red blue green yellow black white pink purple brown gray grey gold silver orange
one two three four five six seven eight nine ten twelve twenty hundred thousand
first second third last next back front left right up down top bottom side middle
january february march april may june july august september october november december
monday tuesday wednesday thursday friday saturday sunday spring summer autumn fall winter
morning evening night today tomorrow yesterday week month year years time hour minute
second always never maybe often sometimes soon later early late now then here there
good bad best better worst nice cool hot cold warm big small tiny huge large little
long short high low fast slow quick easy hard soft smooth rough sharp dark light
new old young fresh clean dirty rich poor free busy empty full open closed true false
yes no ok okay sure fine great awesome super mega ultra hyper power strong weak
password pass pwd passcode passw0rd secret secrets private public admin root user
users guest login logon logout signin signup welcome hello hi hey bye goodbye thanks
please sorry test tests testing demo sample example default master slave server
client system data database file files folder disk drive cloud web site page link
mail email inbox spam chat talk call phone mobile cell tablet laptop computer pc mac
apple google amazon microsoft windows linux ubuntu debian android iphone ipad
facebook twitter youtube insta instagram tiktok snap snapchat whatsapp telegram
skype zoom slack github gitlab netflix spotify paypal ebay uber tesla
python java ruby perl rust swift kotlin react angular vue node npm html css json sql
code coder hack hacker crack cracker cyber geek nerd ninja pirate wizard magic
mypass mypassword letmein trustno qwerty qwert asdf zxcv azerty abcd abcde abcdef
football baseball basketball soccer hockey master dragon monkey shadow sunshine
princess charlie jordan michael jennifer jessica ashley nicole daniel thomas
andrew joshua matthew joseph david chris brian kevin steven jason ryan eric
mark jeff gary larry scott kyle adam alan alex ian jon josh justin tyler zach
anna emma olivia sophia isabella emily abigail madison chloe grace hannah
sarah laura lisa linda susan karen nancy betty helen sandra donna carol ruth
sharon michelle amanda melissa deborah stephanie rebecca sarah laura cynthia
kathleen amy angela shirley anna brenda pamela emma nicole samantha katherine
christine debra rachel catherine carolyn janet ruth maria heather diane
virginia julie joyce victoria kelly christina lauren joan evelyn judith megan
cheryl andrea hannah martha jacqueline frances gloria ann teresa kathryn sara
janice jean alice madison doris abigail julia judy grace denise amber marilyn
beverly danielle theresa sophia marie diana brittany natalie isabella charlotte
rose alexis kayla
james john robert michael william david richard joseph thomas charles christopher
daniel matthew anthony mark donald steven paul andrew joshua kenneth kevin brian
george timothy ronald edward jason jeffrey ryan jacob gary nicholas eric jonathan
stephen larry justin scott brandon benjamin samuel gregory alexander frank patrick
raymond jack dennis jerry tyler aaron jose adam nathan henry douglas zachary peter
kyle ethan walter noah jeremy christian keith roger terry gerald harold sean austin
carl arthur lawrence dylan jesse jordan bryan billy joe bruce gabriel logan albert
willie alan juan wayne elijah randy roy vincent ralph eugene russell bobby mason
philip louis
test1 user1 admin1 pass1 abc123 abcd1 qwe123 asd123 zxc123 iloveyou ilove
bella ciao ciaoo tvb tvtb amore mio amoremio tiamo tiamo ti amo cuore cuori bacio baci
sesso sexy sexo porno porn xxx fuck fuckyou shit damn bitch ass dick cock pussy boob
boobs tits penis vagina gay lesbo nude naked sex sexy hot babe honey sweet sugar
cazzo culo figa merda stronzo puttana troia vaffa palle minchia pirla coglione
dio gesu madonna papa chiesa santo santa angelo diavolo inferno paradiso
bitcoin crypto coin coins money cash dollar euro pound yen gold silver bank
kill killer murder blood skull bone bones ghost devil demon satan hell evil dark
metal rock punk rap hiphop jazz blues pop disco dance music song songs band bands
beatles queen metallica nirvana pink floyd acdc ac dc eminem madonna prince
shakira vasco ligabue jovanotti pausini tiziano ramazzotti zucchero battisti
mina celentano ranieri renato zero pooh negramaro
`;

const RAW_EN = `
able about above abuse actor acute adapt added admit adopt adult after again agent agree
ahead alarm album alert alien align alike alive allow alone along alter among angel anger
angle angry ankle annoy apart apple apply arena argue arise armed array arrow aside asset
audio avoid awake award aware awful basic basis beach beard beast begin being below bench
bible birth black blade blame blank blast blaze bleed blend bless blind block blond blood
bloom board boast bonus boost booth bound brain brake brand brave bread break breed brick
bride brief bring broad broke brown brush build built bunch burst buyer cabin cable camel
candy canoe cargo carry carve catch cause chain chair chalk champ chaos charm chart chase
cheap check cheek cheer chess chest chief child chill china chips choir chose chunk civic
civil claim class clean clear clerk click cliff climb clock close cloth cloud clown coach
coast color couch could count court cover crack craft crane crash crazy cream crime crisp
cross crowd crown crude cruel crush curve cycle daily dance dated dealt death debut decay
delay delta dense depth derby devil diary dirty ditch dodge doing donor doubt dough dozen
draft drain drama drank drawn dream dress dried drift drill drink drive drove drown drunk
dying eager eagle early earth eight elbow elder elect elite empty enemy enjoy enter entry
equal error essay event every exact exist extra faint fairy faith false fancy fatal fault
feast fence fever fiber field fifth fifty fight final first flame flash fleet flesh float
flood floor flour fluid flush focus force forge forth forty forum found frame frank fraud
fresh front frost fruit fully funny ghost giant given glass globe glory glove going grace
grade grain grand grant grape graph grasp grass grave great greed green greet grief grill
grind gross group grown guard guess guest guide guilt habit happy harsh haste haven heart
heavy hello hence herbs hobby holds honey honor horse hotel house human humor hurry ideal
image imply index inner input irony issue ivory jelly jewel joint joker judge juice jumbo
karma knife knock known label labor large laser later laugh layer learn lease least leave
legal lemon level lever light limit linen liver lobby local logic loose lover lower loyal
lucky lunch lying magic major maker maple march match mayor meant medal media melon mercy
merge merit metal meter midst might minor minus mixed model money month moral motor mount
mouse mouth movie music naive naked nasty naval nerve never newly night noble noise north
novel nurse occur ocean offer often olive onion opera orbit order organ other ought outer
owner oxide ozone paint panel panic paper party pasta patch pause peace pearl penny phase
phone photo piano piece pilot pitch pizza place plain plane plant plate plaza point polar
pound power press price pride prime print prior prize probe proof proud prove pulse punch
pupil purse queen query quest queue quick quiet quite quota quote radar radio raise rally
ranch range rapid ratio reach react ready realm rebel refer relax reply rider ridge rifle
right rigid risky rival river roast robot rocky roman rough round route royal rugby ruler
rural sadly safer saint salad sauce scale scare scene scope score scout screw seize sense
serve seven shade shake shall shame shape share shark sharp sheep sheet shelf shell shift
shine shirt shock shoot shore short shout shown sight sigma silly since sixth sixty skill
skirt skull slash sleep slice slide slope small smart smell smile smoke snake solar solid
solve sorry sound south space spare spark speak speed spell spend spent spice spike spine
split spoke sport spray squad stack staff stage stain stair stake stamp stand stare start
state steak steal steam steel steep steer stern stick still stock stone stood store storm
story stove strap straw strip stuck study stuff style sugar suite sunny super surge swamp
swear sweat sweep sweet swept swift swing sword table taste teach teeth tempo tenth thank
theft theme there thick thief thing think third thorn those three threw throw thumb tiger
tight timer tired title toast today token tooth topic torch total touch tough tower toxic
trace track trade trail train trait trash treat trend trial tribe trick tried troop truck
truly trump trunk trust truth tulip twice twist ultra uncle under union unity until upper
upset urban usage usual valid value valve vault venue verse video virus visit vital vivid
vocal voice voter wagon waist waste watch water weigh weird whale wheat wheel where which
while white whole whose widow width witch woman world worry worse worst worth would wound
wrist write wrong yield young youth zebra
able acid aged also area army away baby back ball band bank base bath bear beat been beer
bell belt best bill bird blow blue boat body bomb bond bone book boom boot born boss both
bowl bulk burn bush busy cafe cake call calm came camp card care cart case cash cast cell
chat chip city clam clay clip club coal coat code coin cold come cook cool cope copy cord
core corn cost crew crop crow cube cult cure dark data date dawn days dead deaf deal dean
dear debt deck deed deep deer demo deny desk dial dice diet dirt dish disk dive dock does
doll dome done doom door dose down drag draw drop drug drum duck dull dumb dust duty each
earn ease east easy edge else even ever evil exam exit face fact fade fail fair fall fame
farm fast fate fear feed feel feet fell felt file fill film find fine fire firm fish fist
five flag flat fled flew flip flow foam fold folk fond food fool foot ford fork form fort
four free from fuel full fund gain game gang gate gave gear gene gift girl give glad glow
glue goal goat gods goes gold golf gone good gown grab gray grew grey grid grim grip grow
gulf hair half hall hand hang hard harm hate have head heal hear heat held hell help here
hero hide high hill hint hire hold hole holy home hope horn host hour huge hung hunt hurt
idea idle inch into iron isle item jack jail jazz jean jest join joke jump june jury just
keen keep kept kick kill kind king kiss knee knew know lack lady laid lake lamb lamp land
lane last late lazy lead leaf lean left lend lens less lets liar lies life lift like lime
line link lion list live load loan lock logo long look loop lord lose loss lost loud love
luck lung made mail main make male mall many mark mask mass mate math meal mean meat meet
melt memo menu mere mess mild mile milk mill mind mine miss mode mood moon more most move
much must myth nail name navy near neat neck need nest news next nice nine node none noon
norm nose note noun odds once only onto open oral oven over pace pack page paid pain pair
pale palm park part pass past path peak pick pile pill pine pink pipe plan play plot plug
plus poem poet poke pole poll pond pool poor pope port pose post pour pray pull pump pure
push quit race rack rage raid rail rain rank rare rate read real rear rely rent rest rice
rich ride ring rise risk road rock role roll roof room root rope rose ruby rule rush rust
safe sage said sail sake sale salt same sand sang save seal seat seed seek seem seen self
sell send sent sept ship shoe shop shot show shut sick side sign silk sing sink site size
skin skip slam slap sled slid slim slip slot slow snap snow soap soar sock soft soil sold
sole some song soon sort soul soup sour span spin spit spot star stay stem step stir stop
such suit sure swim tail take tale talk tall tank tape task team tear tech tell tend tent
term test text than that them then they thin this thus tide tidy tied tile till time tiny
tips tire told toll tone took tool tops tore torn tour town toys trap tray tree trim trip
true tube tune turn twin type ugly unit upon urge used user vary vast very vice view vote
wage wait wake walk wall want ward warm warn wash wave ways weak wear week well went were
west what when whom wide wife wild will wind wine wing wire wise wish with wolf wood wool
word wore work worm wrap yard yarn year yell your zero zone zoom
`;

const RAW_IT = `
abate abile abito abuso acero aceto acqua acuto adagio addio aereo affare agile agita
aiuto album alloro altro amara amaro ambra amica amico ampio ancora andare angolo anima
anime antico anzi apice appena aprile arabo arare arca arco ardito arena argento aria arido
armi arpa arte asilo asino asma aspro asta astro atlante atomo attimo audace aula aulico
aurea avere avido avvio azzurro babbo bacca bacio badia baffi bagno baita balla balzo banca
banco barba barca bardo baro basso basta bavero beffa belva bene beta bevo biada bianca
bici bimbo birra bivio bocca bolla bomba bordo borgo borsa bosco botte bracci braccio brace
bravo breve brina brodo bruno bucato buco bufera buio buona burro busta cabina cacao cacca
caldo calma calmo calzo cambio camera campo canale candela canna canto capra carne caro
carro carta casco caso cassa castello catena causa cavo cella cena censo cento cera cerchio
certo cesto cetra chela chiave chiesa chino cibo ciclo cieco cifra cigno cima cinema ciuffo
civile clan clima cobra coda codice colla collo colma colpo colto comico conca conto copia
coppa corda corno corpo corsa corte corto cosa costa cotto covo creta crisi croce cruda
cubo cuffia cugino culla cuoco cuore cupo cura curva custode dado danza dardo dato decina
delta dente denso desco detto diario dieta diga dire disco dito diva diviso dogana dolce
dolore domani dono dopo dorso dosso dote dove dramma drago dubbio duca duello dueto duomo
durata duro ebano ecco edera edito effetto elica elmo enigma epoca eroe erba erede ermo
errore esame esito esodo esordio estate estro etica etto evento evviva extra fabbro faccia
fagiolo falco falla fama fame fango fanno farina farsa fascia fata fatto fauna favola
fazione febbre fede fegato felce felice fermo festa fetta fiaba fiamma fiato fibra fico
fiera figlia figlio fila film filo finale fine finto fiore firma fisco fitto fiume flauto
foce foglia fonda fondo fonte forma forno forse forte forza fosso fotta frana frase fresco
fretta frutto fuga fumo fune funzione fuoco furto fusa fuso gabbia gala galla gamba gara
garbo gatta gatto gelo gemma genio genere gente gesto getto ghiaia ghiro giallo giglio
giro gita giudice giunco gioco gioia gioco giorno giovane gira giusto gnomo goccia golfo
gomma gonna gotico grado grano grappa grasso grato grave greco grida grigio gruppo guado
guanto guardia guerra guida gufo gusto idea idolo ieri igiene imago impero incudine indice
inizio inno insetto inverno invito ippica ira isola iter itaca ladro lago lama lampo lana
lancia lardo largo latte lauda lavoro legge lego leone lepre lesto letto lettera leva lezione
libero libro lido lieto lievito lima limite linea lingua lino liquido lira lite litro livido
lodo logica lombo lontano lotta luce lucido luglio lumaca luna lungo luogo lupa lusso
macchina madre maga magia maglia magro maiale malato male malta mamma mancia mandorla mano
mantello manto mappa marea margine marmo marrone martedi maschera massa matita matto mazza
meglio mela melma membro menta mento mercato merlo mesata messa meta metodo metro mezzo
miele miglio mille mimo mina minimo miope mira misura mito mobile moda modello moglie molla
molto monaco mondo moneta monte moro morso morte mosca mossa motivo moto mucca multa mulino
muro museo musica nafta nano nastro nave nebbia neve nido niente ninfa nobile nodo nome
nonno nord norma nostra notte nove nube nulla numero nuora nuoto nuovo oasi obeso oca
occhio odore offerta oggi olio oliva ombra onda onore opera opaco orafo orario orbita
orchestra ordine orecchio orfano organo orgoglio oriente origine orlo orma oro orso ortica
orto osso ostia ottimo ovest ovvio pacco padre paese paga pagina paio palla palma palo
panca pane panna panno pantano papa parco parete parola parte pasta pasto patata patto
pausa pazzo peggio pelle pena penna pensa pepe pera perla pesca peso petto pezzo piano
piatto piazza picco piede pieno pietra pigro pila pilota pino pioggia pipa pista pizza
plebe poco poema poesia poeta polpa polso pomo ponte porta porto posto potere pozzo prato
preda prezzo prima primo prisma prova prugna pugno pula pulce punta punto pupa pure
quadro quale quasi quota raccolta radio radice raggio ragno rama rame rana rapa rara
rasoio ratto razza reame regalo regina regno remo rene resa resto rete retta riccio riga
rima riso ritmo riva rivale rocca roccia roggia rombo rondine rosa rosso rosta rotta
rotto ruga ruolo ruota russo sabbia sacco sala saldo sale salto salute salvo sano santo
sapere sapone sarto sasso sbarra scala scalo scarpa scena scheda schiena sciame scopo
scorza scuola scusa secco sede sedia seme sempre senno sera serio serpe servo seta sete
sfida sfera sigla signa silenzio sillaba sindaco sipario sirena sismo slitta smalto soda
sogno soldo sole solco somma sonno sopra sorella sorte sosta sotto spada spalla spazio
specchio spesa spia spiga spillo spina spirito sposa spugna squadra stalla stampa stanza
stato stella stima stoffa storia strada strega stufa suono suora superbo svago tabella
tacco tacito taglia talento tana tanto tappo tarda tasca tasto tavola tazza teatro tecnica
tela tema tempo tenda tenore tenue teoria terra terzo tesoro testa tetto tigre timo
tinta tipo tirare titolo toga tomba tondo tono topo torre torta tosse totale tovaglia
tragico trama tramonto trave treno trenta tribu trota trucco tuffo tumulo tuono turno
tutto ubriaco uccello udito uguale ultimo umano umido umile unico unione uovo urlo
uscita usato utile uva vacca vaglia valle valore vano vanto vapore varco vasca vasto
vecchio vela veleno vena vento verbo verde verme vero verso vespa vesta vetro via viaggio
vicino vigna villa vimine vino viola virtu viso vista vita vite vitello vittoria viva
voce voga volo volpe volta voto vuoto zaino zampa zebra zenzero zero zeta zia zio zona
zoppo zucca zuppa
`;

// Parole grezze di 4+ lettere (esportate per i test).
export const PIN_RAW_WORDS: readonly string[] = `${RAW} ${RAW_EN} ${RAW_IT}`.split(/\s+/).filter((w) => /^[a-z]{4,}$/.test(w));

// Il PIN e' lungo 6 con almeno una cifra: il prefisso alfabetico e' lungo al massimo 5.
// Le parole di 6+ lettere (Stefa1, Matte1) entrano col prefisso di 5 e di 4 lettere.
export const PIN_BLOCKLIST: ReadonlySet<string> = new Set(
  PIN_RAW_WORDS.flatMap((w) => (w.length <= 5 ? [w] : [w.slice(0, 5), w.slice(0, 4)])),
);
