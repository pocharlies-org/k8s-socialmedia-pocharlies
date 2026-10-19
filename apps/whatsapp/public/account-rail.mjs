export function accountInitials(label) {
  const parts = String(label || '').trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || '?').toLocaleUpperCase();
}

export function markActiveAccount(container, accountId) {
  for (const button of container.querySelectorAll('button[data-account-id]')) {
    const active = button.dataset.accountId === accountId;
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('is-active', active);
  }
}

export function renderAccountRail(container, accounts, activeId, onSelect, documentRef = document) {
  container.replaceChildren();
  for (const account of accounts) {
    const button = documentRef.createElement('button');
    const label = String(account.label || account.id);
    button.type = 'button';
    button.className = 'rail-account';
    button.dataset.accountId = account.id;
    button.setAttribute('aria-label', `Cuenta de WhatsApp: ${label}`);
    button.title = label;
    const initials = documentRef.createElement('span');
    initials.className = 'rail-account-initials';
    initials.setAttribute('aria-hidden', 'true');
    initials.textContent = accountInitials(label);
    button.append(initials);
    button.addEventListener('click', () => onSelect(account.id));
    container.append(button);
  }
  markActiveAccount(container, activeId);
}
