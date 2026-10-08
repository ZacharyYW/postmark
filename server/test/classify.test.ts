import { describe, expect, it } from 'vitest';
import { classifyClick, classifyOpen, isAppleMailShaped } from '../src/tracking/classify';
import { ipInCidrs, parseCidrList } from '../src/tracking/cidr';
import { CLICK_FIXTURES, OPEN_FIXTURES } from './fixtures/user-agents';

describe('classifyOpen fixtures', () => {
  it.each(OPEN_FIXTURES)('%s', (_name, ua, ms, inRange, expected) => {
    expect(
      classifyOpen({ ua, msSinceSent: ms, ipInMppRange: inRange, senderSigValid: false }),
    ).toBe(expected);
  });

  it('valid sender signature always wins', () => {
    expect(
      classifyOpen({
        ua: 'GoogleImageProxy',
        msSinceSent: 999_999,
        ipInMppRange: false,
        senderSigValid: true,
      }),
    ).toBe('sender');
  });

  it('null UA is a bot', () => {
    expect(
      classifyOpen({ ua: null, msSinceSent: 999_999, ipInMppRange: false, senderSigValid: false }),
    ).toBe('bot');
  });
});

describe('classifyClick fixtures', () => {
  it.each(CLICK_FIXTURES)('%s', (_name, ua, ms, expected) => {
    expect(classifyClick({ ua, msSinceSent: ms, ipInMppRange: false, senderSigValid: false })).toBe(
      expected,
    );
  });
});

describe('isAppleMailShaped', () => {
  it('accepts WebKit without browser token, rejects Safari/Chrome', () => {
    expect(
      isAppleMailShaped('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)'),
    ).toBe(true);
    expect(isAppleMailShaped('Mozilla/5.0 AppleWebKit/605.1.15 Version/17 Safari/605.1.15')).toBe(
      false,
    );
    expect(isAppleMailShaped('Mozilla/5.0 AppleWebKit/537.36 Chrome/126 Safari/537.36')).toBe(
      false,
    );
  });
});

describe('CIDR matching', () => {
  const cidrs = parseCidrList('17.0.0.0/8, 2620:149::/32, 10.1.2.3, bogus, 1.2.3.4/99');
  it.each([
    ['17.1.2.3', true],
    ['::ffff:17.200.0.1', true],
    ['18.0.0.1', false],
    ['10.1.2.3', true],
    ['10.1.2.4', false],
    ['2620:149:a:b::1', true],
    ['2620:14a::1', false],
    ['not-an-ip', false],
    ['unknown', false],
  ])('%s → %s', (ip, expected) => {
    expect(ipInCidrs(ip, cidrs)).toBe(expected);
  });
  it('ignores invalid entries', () => {
    expect(cidrs).toHaveLength(3);
  });
});
