function beijingParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return { year: parts.year, month: parts.month, day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

function stateMonth(date = new Date()) {
  const p = beijingParts(date);
  return `${p.year}-${p.month}`;
}

function isFinalRetryDay(date = new Date(), finalDay = 3) {
  return beijingParts(date).day >= finalDay;
}

module.exports = { beijingParts, stateMonth, isFinalRetryDay };
