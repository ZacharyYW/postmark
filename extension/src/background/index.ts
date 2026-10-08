// InboxSDK's MV3 helper: injects pageWorld.js into Gmail's main world on request.
import '@inboxsdk/core/background.js';
import { createRouter } from '../bus/router';
import { POLL_ALARM, REMINDER_ALARM_PREFIX } from './reminderLogic';
import { PostmarkService } from './service';

const service = new PostmarkService();

// Listeners must be registered synchronously at top level so MV3 wakes the worker for them.
chrome.runtime.onMessage.addListener(createRouter(service.handlers(), chrome.runtime.id));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    void service.poll();
  } else if (alarm.name.startsWith(REMINDER_ALARM_PREFIX)) {
    void service
      .onReminderAlarm(alarm.name.slice(REMINDER_ALARM_PREFIX.length))
      .catch((err: unknown) => console.warn('[postmark] reminder check failed', err));
  }
});

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith('pm:')) void service.onNotificationClicked(id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void service.forgetTab(tabId);
});

const boot = () => {
  void service.schedulePolling();
  void service.syncReminderAlarms().catch(() => undefined);
};
chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener((details) => {
  boot();
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
});
