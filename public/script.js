const $ = (id) => document.getElementById(id);

const topbar = $('topbar');
const who = $('who');
const logoutBtn = $('logout');
const strip = $('strip');
const loginView = $('login-view');
const rewardsView = $('rewards-view');
const form = $('login-form');
const emailInput = $('email');
const errorEl = $('error');
const submitBtn = $('submit');
const visitCount = $('visit-count');
const visitWord = $('visit-word');
const tracker = $('tracker');
const detail = $('detail');
const detailHeadline = $('detail-headline');
const detailChip = $('detail-chip');
const detailText = $('detail-text');
const viewAllBtn = $('view-all');
const claimBtn = $('claim-btn');
const nextEl = $('next');
const toast = $('toast');

const rewardsPage = $('rewards-page');
const pageTitle = $('page-title');
const pageSub = $('page-sub');
const timeline = $('timeline');
const pageBack = $('page-back');
const pageGoBack = $('page-go-back');

const popup = $('visit-popup');
const popupTitle = $('popup-title');
const popupSub = $('popup-sub');
const popupReward = $('popup-reward');
const popupRewardIcon = $('popup-reward-icon');
const popupRewardTitle = $('popup-reward-title');
const popupRewardText = $('popup-reward-text');
const popupView = $('popup-view');
const popupClose = $('popup-close');

let state = null;           // latest data from the server
let selectedIndex = 0;      // which coupon is selected
let popupRewardIndex = -1;  // reward shown in the visit pop-up (-1 = none)
let toastTimer = null;

const STATUS_TEXT = { claimed: 'Claimed', available: 'Available', locked: 'Locked' };

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// 1 -> 1st, 2 -> 2nd, 3 -> 3rd, 11 -> 11th, 21 -> 21st
function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

// 7 OCT '26
function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const month = d.toLocaleString('en-IN', { month: 'short' }).toUpperCase();
  return `${d.getDate()} ${month} '${String(d.getFullYear()).slice(-2)}`;
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
  emailInput.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
}

// ---------- Visit completed pop-up ----------
function showVisitPopup(data) {
  // The reward that unlocks exactly on this visit (e.g. 1st visit -> welcome reward)
  const index = data.offers.findIndex(
    (offer) => offer.minVisits === data.visits && offer.status !== 'claimed'
  );
  const reward = index >= 0 ? data.offers[index] : null;

  popupTitle.textContent = `${ordinal(data.visits)} visit completed!`;

  if (reward) {
    popupSub.textContent =
      data.visits === 1 ? 'Welcome! Here is your reward.' : 'You unlocked a new reward!';
    popupRewardIcon.textContent = reward.icon;
    popupRewardTitle.textContent = reward.headline;
    popupRewardText.textContent = reward.text;
  } else if (data.next) {
    popupSub.textContent =
      `${plural(data.next.visitsAway, 'more visit')} to unlock "${data.next.headline}".`;
  } else {
    popupSub.textContent = 'You have unlocked every reward. Thank you!';
  }

  popupReward.hidden = !reward;
  popupView.hidden = !reward;
  popupRewardIndex = index;

  popup.hidden = false;
  document.body.style.overflow = 'hidden';
  (reward ? popupView : popupClose).focus();
}

function closePopup() {
  popup.hidden = true;
  document.body.style.overflow = '';
}

// Pink offer cards at the top. visits = null means "not signed in" (show all as teasers).
function renderStrip(offers, visits) {
  strip.replaceChildren();
  offers.forEach((offer) => {
    const locked = visits !== null && visits < offer.minVisits;

    const card = document.createElement('div');
    card.className = 'offer-card' + (locked ? ' locked' : '');

    const title = document.createElement('h3');
    const [first, ...rest] = offer.headline.split(' ');
    title.append(first, document.createElement('br'), rest.join(' '));
    card.append(title);

    if (locked || offer.status === 'claimed') {
      const small = document.createElement('small');
      small.textContent = locked
        ? `Unlocks at ${plural(offer.minVisits, 'visit')}`
        : 'Claimed ✓';
      card.append(small);
    }

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = offer.icon;
    card.append(icon);

    strip.append(card);
  });
  strip.hidden = offers.length === 0;
}

// Coupons joined by progress lines.
function renderTracker() {
  const { offers, visits } = state;
  tracker.replaceChildren();

  offers.forEach((offer, index) => {
    if (index > 0) {
      const prev = offers[index - 1];
      const share = (visits - prev.minVisits) / (offer.minVisits - prev.minVisits);
      const pct = Math.max(0, Math.min(1, share)) * 100;

      const link = document.createElement('div');
      link.className = 'link';
      const fill = document.createElement('i');
      fill.style.width = `${pct}%`;
      link.append(fill);
      tracker.append(link);
    }

    const step = document.createElement('div');
    step.className = 'step';

    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      'coupon' + (offer.unlocked ? '' : ' locked') + (index === selectedIndex ? ' selected' : '');
    button.textContent = offer.unlocked ? '✓' : '%';
    button.setAttribute('aria-label', `${offer.headline}, ${STATUS_TEXT[offer.status]}`);
    button.addEventListener('click', () => selectStep(index));

    const label = document.createElement('span');
    label.className = 'step-label';
    label.textContent = plural(offer.minVisits, 'visit');

    step.append(button, label);
    tracker.append(step);
  });
}

function positionArrow() {
  const selected = tracker.querySelector('.coupon.selected');
  if (!selected) return;
  const box = selected.getBoundingClientRect();
  const x = box.left + box.width / 2 - detail.getBoundingClientRect().left;
  detail.style.setProperty('--arrow-x', `${x}px`);
}

// The card under the coupons.
function renderDetail() {
  const offer = state.offers[selectedIndex];

  detailHeadline.textContent = offer.headline;
  detailChip.textContent = STATUS_TEXT[offer.status];
  detailChip.className =
    'chip' + (offer.status === 'claimed' ? ' ok' : offer.status === 'available' ? ' avail' : '');

  if (offer.status === 'claimed') {
    detailText.textContent = `Reward claimed on ${formatDate(offer.claimedAt)}`;
  } else if (offer.status === 'available') {
    detailText.textContent = offer.text;
  } else {
    const left = offer.minVisits - state.visits;
    detailText.textContent =
      `Unlocks at ${plural(offer.minVisits, 'visit')} · ${plural(left, 'more visit')} to go`;
  }

  claimBtn.hidden = offer.status !== 'available';
  positionArrow();
}

function selectStep(index) {
  selectedIndex = index;
  renderTracker();
  renderDetail();
}

// ---------- All rewards page ----------
function timelineItem(offer, index) {
  const { offers, visits } = state;

  const li = document.createElement('li');
  li.className = `tl-item ${offer.status}`;

  // Left column: coupon icon + line down to the next reward
  const rail = document.createElement('div');
  rail.className = 'tl-rail';

  const icon = document.createElement('span');
  icon.className = 'coupon mini' + (offer.unlocked ? '' : ' locked');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = offer.unlocked ? '✓' : '%';
  rail.append(icon);

  if (index < offers.length - 1) {
    const nextOffer = offers[index + 1];
    const share = (visits - offer.minVisits) / (nextOffer.minVisits - offer.minVisits);
    const pct = Math.max(0, Math.min(1, share)) * 100;

    const line = document.createElement('div');
    line.className = 'tl-line';
    const fill = document.createElement('i');
    fill.style.height = `${pct}%`;
    line.append(fill);
    rail.append(line);
  }

  // Right column: title, status chip, details
  const body = document.createElement('div');
  body.className = 'tl-body';

  const top = document.createElement('div');
  top.className = 'tl-top';

  const title = document.createElement('strong');
  title.className = 'tl-title';
  title.textContent = offer.headline;
  top.append(title);

  if (offer.status !== 'locked') {
    const chip = document.createElement('span');
    chip.className = 'tl-chip' + (offer.status === 'available' ? ' avail' : '');
    chip.textContent = STATUS_TEXT[offer.status];
    top.append(chip);
  }

  const text = document.createElement('p');
  text.className = 'tl-text';
  if (offer.status === 'claimed') {
    text.textContent = `Reward claimed on ${formatDate(offer.claimedAt)}`;
  } else if (offer.status === 'available') {
    text.textContent = offer.text;
  } else {
    const left = offer.minVisits - visits;
    text.textContent = `Visit ${plural(left, 'more time')} to unlock this reward!`;
  }

  body.append(top, text);

  if (offer.status === 'available') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'claim-small';
    button.textContent = 'Claim reward';
    button.addEventListener('click', () => claimOffer(offer));
    body.append(button);
  }

  li.append(rail, body);
  return li;
}

function renderPage() {
  const { offers, next } = state;

  if (next) {
    pageTitle.textContent = 'Visit more to win rewards!';
    pageSub.textContent = `Visit ${plural(next.visitsAway, 'more time')} to unlock`;
  } else {
    pageTitle.textContent = 'All rewards unlocked!';
    pageSub.textContent = 'You have unlocked every reward 🎉';
  }

  timeline.replaceChildren();
  offers.forEach((offer, index) => timeline.append(timelineItem(offer, index)));
}

function openPage() {
  if (!state) return;
  renderPage();
  rewardsPage.hidden = false;
  rewardsPage.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  pageBack.focus();
}

function closePage() {
  rewardsPage.hidden = true;
  document.body.style.overflow = '';
  if (!rewardsView.hidden) viewAllBtn.focus();
}

// ---------- Claiming ----------
async function claimOffer(offer) {
  const sure = window.confirm(
    `Claim "${offer.headline}"?\n\nTap OK only at the billing counter, with the cashier. A claimed reward can't be used again.`
  );
  if (!sure) return;

  try {
    const res = await fetch('/api/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minVisits: offer.minVisits })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not claim. Try again.');

    showRewards(data, true);
    showToast('Reward claimed 🎉');
  } catch (err) {
    showToast(err.message);
  }
}

// ---------- Screens ----------
function showRewards(data, keepSelection = false) {
  state = data;
  if (!keepSelection) selectedIndex = Math.max(0, data.currentIndex);

  who.textContent = data.email;
  visitCount.textContent = data.visits;
  visitWord.textContent = data.visits === 1 ? 'visit' : 'visits';

  const scroll = strip.scrollLeft;
  renderStrip(data.offers, data.visits);
  strip.scrollLeft = scroll;

  topbar.hidden = false;
  loginView.hidden = true;
  rewardsView.hidden = false;

  renderTracker();
  renderDetail();

  if (data.next) {
    nextEl.textContent =
      `${plural(data.next.visitsAway, 'more visit')} to unlock "${data.next.headline}"`;
  } else {
    nextEl.textContent = 'You have unlocked every reward 🎉';
  }
  nextEl.hidden = false;

  if (!rewardsPage.hidden) renderPage();
}

function showLogin(offers) {
  state = null;
  closePopup();
  closePage();
  topbar.hidden = true;
  rewardsView.hidden = true;
  loginView.hidden = false;
  renderStrip(offers || [], null);
}

// ---------- Events ----------
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  submitBtn.disabled = true;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailInput.value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');

    showRewards(data);
    if (data.newVisit) showVisitPopup(data);
  } catch (err) {
    showError(err.message);
  } finally {
    submitBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
  emailInput.value = '';
  init();
});

viewAllBtn.addEventListener('click', openPage);
pageBack.addEventListener('click', closePage);
pageGoBack.addEventListener('click', closePage);

claimBtn.addEventListener('click', () => {
  if (state) claimOffer(state.offers[selectedIndex]);
});

popupClose.addEventListener('click', closePopup);
popupView.addEventListener('click', () => {
  const index = popupRewardIndex;
  closePopup();
  if (state && index >= 0) {
    selectStep(index);
    detail.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});
popup.addEventListener('click', (event) => {
  if (event.target === popup) closePopup();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!popup.hidden) closePopup();
  else if (!rewardsPage.hidden) closePage();
});

window.addEventListener('resize', () => { if (state) positionArrow(); });

// Runs every time the page opens.
async function init() {
  // /scan sends people here with ?counted=1 after adding a visit
  const counted = new URLSearchParams(location.search).get('counted') === '1';
  if (location.search) history.replaceState(null, '', location.pathname);

  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (res.ok) {
      showRewards(data);
      if (counted) showVisitPopup(data);
      return;
    }
    showLogin(data.offers);
    return;
  } catch (_) {}
  showLogin([]);
}

init();