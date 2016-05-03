/* @flow */
//jshint ignore:start

import _ from 'lodash';
import {defn, defonce} from 'ud';
import assert from 'assert';
import Kefir from 'kefir';
import asap from 'asap';
import kefirBus from 'kefir-bus';

import assertInterface from '../../../lib/assert-interface';
import makeMutationObserverChunkedStream from '../../../lib/dom/make-mutation-observer-chunked-stream';
import kefirCast from 'kefir-cast';
import ThreadRowViewDriver from '../../../driver-interfaces/thread-row-view-driver';
import delayAsap from '../../../lib/delay-asap';
import kefirStopper from 'kefir-stopper';

import GmailDropdownView from '../widgets/gmail-dropdown-view';
import DropdownView from '../../../widgets/buttons/dropdown-view';
import GmailLabelView from '../widgets/gmail-label-view';
import GmailActionButtonView from '../widgets/gmail-action-button-view';
import type GmailDriver from '../gmail-driver';
import type GmailRowListView from './gmail-row-list-view';

import updateIcon from '../lib/update-icon/update-icon';

type LabelMod = {gmailLabelView: Object, remove(): void};
type ActionButtonMod = {gmailActionButtonView: GmailActionButtonView, remove(): void};
type ButtonMod = {buttonSpan: HTMLElement, iconSettings: Object, remove(): void};
type ImageMod = {iconSettings: Object, iconWrapper: HTMLElement, remove(): void};
type ReplacedDateMod = {el: HTMLElement, remove(): void};
type ReplacedDraftLabelMod = ReplacedDateMod;

type Mods = {
  label: {unclaimed: LabelMod[], claimed: LabelMod[]};
  action: {unclaimed: ActionButtonMod[], claimed: ActionButtonMod[]};
  button: {unclaimed: ButtonMod[], claimed: ButtonMod[]};
  image: {unclaimed: ImageMod[], claimed: ImageMod[]};
  replacedDate: {unclaimed: ReplacedDateMod[], claimed: ReplacedDateMod[]};
  replacedDraftLabel: {unclaimed: ReplacedDraftLabelMod[], claimed: ReplacedDraftLabelMod[]};
};

const cachedModificationsByRow: WeakMap<HTMLElement, Mods> = defonce(module, () => new WeakMap());

const identity = x => x;

function focusAndNoPropagation(event) {
  this.focus();
  event.stopImmediatePropagation();
}

function starGroupEventInterceptor(event) {
  const isOnStar = this.firstElementChild.contains(event.target);
  const isOnSDKButton = !isOnStar && this !== event.target;
  if (!isOnStar) {
    event.stopImmediatePropagation();
    if (!isOnSDKButton || event.type == 'mouseover') {
      const newEvent: Object = document.createEvent('MouseEvents');
      newEvent.initMouseEvent(
        event.type, event.bubbles, event.cancelable, event.view,
        event.detail, event.screenX, event.screenY, event.clientX, event.clientY,
        event.ctrlKey, event.altKey, event.shiftKey, event.metaKey,
        event.button, event.relatedTarget
      );
      this.parentElement.dispatchEvent(newEvent);
    }
  }
}

// Change a color very slightly to force a re-render
function tweakColor(color) {
  // example:
  // "rgba(255, 255, 255, 0.9)" -> "rgba(254, 254, 254, 0.9)"
  if (typeof color === 'string') {
    return color.replace(/(\d+),/g, (full, num) => (num^1)+',');
  }
  return color;
}

type Counts = {
  messageCount: number;
  draftCount: number;
};

class GmailThreadRowView {
  _elements: HTMLElement[];
  _modifications: Mods;
  _alreadyHadModifications: boolean;
  _rowListViewDriver: GmailRowListView;
  _driver: GmailDriver;
  _userView: ?Object;
  _cachedThreadID: ?string;
  _didSubscribeTextFixerRun: boolean = false;
  _imageFixer: ?Kefir.Bus;
  _imageFixerTask: ?Kefir.Stream;
  _stopper: Kefir.Stopper;
  _refresher: ?Kefir.Stream;
  _subjectRefresher: ?Kefir.Stream;
  _counts: ?Counts;
  _isVertical: boolean;
  _isDestroyed: boolean = false;

  constructor(element: HTMLElement, rowListViewDriver: GmailRowListView, gmailDriver: GmailDriver) {
    assert(element.hasAttribute('id'), 'check element is main thread row');

    this._isVertical = _.intersection(_.toArray(element.classList), ['zA','apv']).length === 2;
    if (this._isVertical) {
      const threadRow3 = element.nextElementSibling.nextElementSibling;
      const has3Rows = (threadRow3 && threadRow3.classList.contains('apw'));
      this._elements = has3Rows ?
        [
          element,
          (element:any).nextElementSibling,
          (element:any).nextElementSibling.nextElementSibling
        ] : [
          element,
          (element:any).nextElementSibling
        ];
    } else {
      this._elements = [element];
    }

    this._modifications = cachedModificationsByRow.get(this._elements[0]);
    if (!this._modifications) {
      this._alreadyHadModifications = false;
      this._modifications = {
        label: {unclaimed: [], claimed: []},
        action: {unclaimed: [], claimed: []},
        button: {unclaimed: [], claimed: []},
        image: {unclaimed: [], claimed: []},
        replacedDate: {unclaimed: [], claimed: []},
        replacedDraftLabel: {unclaimed: [], claimed: []}
      };
      cachedModificationsByRow.set(this._elements[0], this._modifications);
    } else {
      this._alreadyHadModifications = true;
    }

    this._rowListViewDriver = rowListViewDriver;
    this._driver = gmailDriver;
    this._userView = null; // supplied by ThreadRowView
    this._cachedThreadID = null; // set in getter

    this._stopper = kefirStopper();


    this._imageFixer = null;
    this._imageFixerTask = null;
    this._refresher = null;
    this._subjectRefresher = null;
    this._counts = null;

    this._elements[0].classList.add('inboxsdk__thread_row');
  }

  destroy() {
    if(!this._elements.length){
      return;
    }

    this._isDestroyed = true;

    this._modifications.label.unclaimed = this._modifications.label.claimed
      .concat(this._modifications.label.unclaimed);
    this._modifications.label.claimed.length = 0;

    this._modifications.action.unclaimed = this._modifications.action.claimed
      .concat(this._modifications.action.unclaimed);
    this._modifications.action.claimed.length = 0;

    this._modifications.button.unclaimed = this._modifications.button.claimed
      .concat(this._modifications.button.unclaimed);
    this._modifications.button.claimed.length = 0;

    this._modifications.image.unclaimed = this._modifications.image.claimed
      .concat(this._modifications.image.unclaimed);
    this._modifications.image.claimed.length = 0;

    this._modifications.replacedDate.unclaimed = this._modifications.replacedDate.claimed
      .concat(this._modifications.replacedDate.unclaimed);
    this._modifications.replacedDate.claimed.length = 0;

    this._modifications.replacedDraftLabel.unclaimed = this._modifications.replacedDraftLabel.claimed
      .concat(this._modifications.replacedDraftLabel.unclaimed);
    this._modifications.replacedDraftLabel.claimed.length = 0;

    _.chain(this._elements)
      .map((el) => el.getElementsByClassName('inboxsdk__thread_row_addition'))
      .map(_.toArray)
      .flatten()
      .value().forEach((el) => {
        el.remove();
      });

    this._stopper.destroy();
    this._elements.length = 0;
  }

  _removeUnclaimedModifications() {
    _removeThreadRowUnclaimedModifications(this._modifications);

    // TODO fix column width to deal with removed buttons
  }

  getAlreadyHadModifications(): boolean {
    return this._alreadyHadModifications;
  }

  // Returns a Kefir stream that emits this object once this object is ready for the
  // user. It should almost always synchronously ready immediately, but there's
  // a few cases such as with multiple inbox that it needs a moment.
  // make sure you take until by on the gmailThreadRowView.getStopper() because waitForReady
  // must not be called after the gmailThreadRowView is destroyed
  waitForReady(): Kefir.Stream<GmailThreadRowView> {
    if(!this._elements.length) {
      //TODO: remove if never logged
      this._driver.getLogger().error(new Error('tried to get thread id on empty array'), {
        isDestroyed: this._isDestroyed
      });

      return Kefir.never();
    }

    const time = [0,10,100];
    const step = () => {
      if (this._threadIdReady()) {
        asap(() => {
          if (this._elements.length)
            this._removeUnclaimedModifications();
        });
        return Kefir.constant(this);
      } else {
        const stepTime = time.shift();
        if (stepTime == undefined) {
          console.log('Should not happen: ThreadRowViewDriver never became ready', this);
          return Kefir.never();
        } else {
          return Kefir.later(stepTime).flatMap(step);
        }
      }
    };

    return step();
  }

  setUserView(userView: Object) {
    this._userView = userView;
  }

  getCounts(): Counts {
    let counts = this._counts;
    if(!counts){
      const thing = this._elements[0].querySelector('td div.yW');
      const [preDrafts, drafts] = thing.innerHTML.split(/<font color=[^>]+>[^>]+<\/font>/);

      const preDraftsWithoutNames = preDrafts.replace(/<span\b[^>]*>.*?<\/span>/g, '');

      const messageCountMatch = preDraftsWithoutNames.match(/\((\d+)\)/);
      const messageCount = messageCountMatch ? +messageCountMatch[1] : (preDrafts ? 1 : 0);

      const draftCountMatch = drafts && drafts.match(/\((\d+)\)/);
      const draftCount = draftCountMatch ? +draftCountMatch[1] : (drafts != null ? 1 : 0);
      counts = this._counts = {messageCount, draftCount};
    }

    return counts;
  }

  _expandColumn(colSelector: string, width: number) {
    this._rowListViewDriver.expandColumn(colSelector, width);
  }

  addLabel(label: Object) {
    if (!this._elements.length) {
      console.warn('addLabel called on destroyed thread row');
      return;
    }
    const prop: Kefir.Stream = kefirCast(Kefir, label).takeUntilBy(this._stopper).toProperty();
    var labelMod = null;

    prop.combine(this._getRefresher(), identity).takeUntilBy(this._stopper).onValue(labelDescriptor => {
      if(!labelDescriptor){
        if (labelMod) {
          labelMod.remove();
          this._modifications.label.claimed.splice(
            this._modifications.label.claimed.indexOf(labelMod), 1);
          labelMod = null;
        }
      } else {
        if (!labelMod) {
          labelMod = this._modifications.label.unclaimed.shift();
          if (!labelMod) {
            const gmailLabelView = new GmailLabelView({
              classes: ['inboxsdk__thread_row_label']
            });
            const el = gmailLabelView.getElement();
            labelMod = {
              gmailLabelView,
              remove: el.remove.bind(el)
            };
          }
          this._modifications.label.claimed.push(labelMod);
        }

        labelMod.gmailLabelView.updateLabelDescriptor(labelDescriptor);

        const labelParentDiv = this._getLabelParent();
        if (!_.contains(labelParentDiv.children, labelMod.gmailLabelView.getElement())) {
          labelParentDiv.insertBefore(
            labelMod.gmailLabelView.getElement(), labelParentDiv.lastChild);
        }
        this._getImageFixer().emit();
      }
    });
  }

  addImage(inIconDescriptor: Object){
    if (!this._elements.length) {
      console.warn('addImage called on destroyed thread row');
      return;
    }
    const prop: Kefir.Stream = kefirCast(Kefir, inIconDescriptor)
                  .toProperty()
                  .combine(this._getRefresher(), identity)
                  .combine(this._getSubjectRefresher(), identity)
                  .takeUntilBy(this._stopper);

    let imageMod = null;

    prop.onValue(iconDescriptor => {
      if (!iconDescriptor) {
        if (imageMod) {
          imageMod.remove();
          this._modifications.image.claimed.splice(
            this._modifications.image.claimed.indexOf(imageMod), 1);
          imageMod = null;
        }
      } else {
        if (!imageMod) {
          imageMod = this._modifications.image.unclaimed.shift();
          if (!imageMod) {

            imageMod = {
              iconSettings: {},
              iconWrapper: document.createElement('div'),
              remove() {
                this.iconWrapper.remove();
              }
            };
            imageMod.iconWrapper.className = 'inboxsdk__thread_row_icon_wrapper';
          }
          this._modifications.image.claimed.push(imageMod);
        }
        const {iconSettings, iconWrapper} = imageMod;

        updateIcon(iconSettings, iconWrapper, false, iconDescriptor.imageClass, iconDescriptor.imageUrl);

        const containerRow = this._elements.length === 3 ? this._elements[2] : this._elements[0];
        containerRow.classList.add('inboxsdk__thread_row_image_added');

        if(iconDescriptor.tooltip){
          iconSettings.iconElement.setAttribute('data-tooltip', iconDescriptor.tooltip);
        }

        if(!this._elements[0].contains(iconWrapper)) {
          const insertionPoint = this._elements.length > 1 ?
                                this._getLabelParent() :
                                this._getLabelParent().querySelector('.y6');

          insertionPoint.insertBefore(iconWrapper, insertionPoint.firstElementChild);
        }
        this._getImageFixer().emit();
      }
    });

    this._getImageFixerTask().onValue(() => {
      const el = imageMod && imageMod.iconWrapper && imageMod.iconWrapper.firstElementChild;
      if (el) {
        // Make the image reposition itself horizontally.
        el.style.display = (el.style && el.style.display === 'block') ? 'inline-block' : 'block';
      }
    });
    this._subscribeTextFixer();
  }

  addButton(buttonDescriptor: Object) {
    if (!this._elements.length) {
      console.warn('addButton called on destroyed thread row');
      return;
    }
    if (this._elements.length != 1) return; // buttons not supported in vertical preview pane

    var activeDropdown = null;
    var buttonMod = null;


    var prop: Kefir.Stream = kefirCast(Kefir, buttonDescriptor).toProperty().takeUntilBy(this._stopper);

    prop.beforeEnd(() => null).onValue(buttonDescriptor => {
      if (!buttonDescriptor) {
        if (activeDropdown) {
          activeDropdown.close();
          activeDropdown = null;
        }
      }
    });

    prop.onEnd(() => {
      if (buttonMod && buttonMod.buttonSpan) {
        (buttonMod.buttonSpan:any).onclick = null;
      }
    });

    prop.combine(this._getRefresher(), identity).onValue(buttonDescriptor => {
      if (!buttonDescriptor) {
        if (buttonMod) {
          buttonMod.remove();
          this._modifications.button.claimed.splice(
            this._modifications.button.claimed.indexOf(buttonMod), 1);
          buttonMod = null;
        }
      } else {
        // compat workaround
        if (buttonDescriptor.className) {
          buttonDescriptor.iconClass = buttonDescriptor.className;
          delete buttonDescriptor.className;
        }

        // could also be trash icon
        const starGroup = this._elements[0].querySelector('td.apU.xY, td.aqM.xY');

        let buttonSpan, iconSettings;
        if (!buttonMod) {
          buttonMod = this._modifications.button.unclaimed.shift();
          if (!buttonMod) {
            buttonSpan = document.createElement('span');
            buttonSpan.className = 'inboxsdk__thread_row_button';
            buttonSpan.setAttribute('tabindex', "-1");
            (buttonSpan:any).addEventListener('onmousedown', focusAndNoPropagation);

            iconSettings = {
              iconUrl: null,
              iconClass: null,
              iconElement: null,
              iconImgElement: null
            };

            buttonMod = {
              buttonSpan,
              iconSettings,
              remove: buttonSpan.remove.bind(buttonSpan)
            };
          }
          this._modifications.button.claimed.push(buttonMod);
        }

        buttonSpan = buttonMod.buttonSpan;
        iconSettings = buttonMod.iconSettings;

        if(buttonDescriptor.onClick){
          (buttonSpan:any).onclick = (event) => {
            const appEvent = {
              dropdown: null,
              threadRowView: this._userView
            };
            if (buttonDescriptor.hasDropdown) {
              if (activeDropdown) {
                this._elements[0].classList.remove('inboxsdk__dropdown_active');
                activeDropdown.close();
                activeDropdown = null;
                return;
              } else {
                this._elements[0].classList.add('inboxsdk__dropdown_active');
                appEvent.dropdown = activeDropdown = new DropdownView(new GmailDropdownView(), buttonSpan, null);
                activeDropdown.setPlacementOptions({
                  position: 'bottom', hAlign: 'left', vAlign: 'top'
                });
                activeDropdown.on('destroy', function() {
                  setTimeout(function() {
                    activeDropdown = null;
                  }, 1);
                });
              }
            }
            buttonDescriptor.onClick.call(null, appEvent);
          };
        }

        updateIcon(iconSettings, buttonSpan, false, buttonDescriptor.iconClass, buttonDescriptor.iconUrl);
        if (!_.contains(starGroup.children, buttonSpan)) {
          starGroup.appendChild(buttonSpan);
          this._expandColumn('col.y5', 26*starGroup.children.length);

          // Don't let the whole column count as the star for click and mouse over purposes.
          // Click events that aren't directly on the star should be stopped.
          // Mouseover events that aren't directly on the star should be stopped and
          // re-emitted from the thread row, so the thread row still has the mouseover
          // appearance.
          // Click events that are on one of our buttons should be stopped. Click events
          // that aren't on the star button or our buttons should be re-emitted from the
          // thread row so it counts as clicking on the thread.
          (starGroup:any).onmouseover = (starGroup:any).onclick = starGroupEventInterceptor;
        }
        this._getImageFixer().emit();
      }
    });
  }

  addActionButton(actionButtonDescriptor: Object) {
    if (this._elements.length !== 1) {
      return;
    }
    const prop: Kefir.Stream = kefirCast(Kefir, actionButtonDescriptor).takeUntilBy(this._stopper).toProperty();
    let actionMod = null;

    prop.onEnd(() => {
      if (actionMod) {
        actionMod.gmailActionButtonView.setOnClick(null);
      }
    });

    prop.takeUntilBy(this._stopper).onValue(actionButtonDescriptor => {
      if (actionButtonDescriptor && actionButtonDescriptor.type !== 'LINK') {
        console.error('Only type=LINK is currently supported');
        return;
      }

      if(!actionButtonDescriptor){
        if (actionMod) {
          actionMod.remove();
          this._modifications.action.claimed.splice(
            this._modifications.action.claimed.indexOf(actionMod), 1);
          actionMod = null;
        }
      } else {
        if (!actionMod) {
          actionMod = this._modifications.action.unclaimed.shift();
          if (!actionMod) {
            const gmailActionButtonView = new GmailActionButtonView();
            const el = gmailActionButtonView.getElement();
            actionMod = {
              gmailActionButtonView,
              remove: el.remove.bind(el)
            };
          }
          this._modifications.action.claimed.push(actionMod);
        }

        actionMod.gmailActionButtonView.updateDescriptor(actionButtonDescriptor);
        actionMod.gmailActionButtonView.setOnClick((event) => {
          event.stopPropagation();
          window.open(actionButtonDescriptor.url, '_blank');
          if (actionButtonDescriptor.onClick) {
            actionButtonDescriptor.onClick.call(null, {});
          }
        });

        const actionParentDiv = (this._getLabelParent().parentElement: any);
        if (!_.contains(actionParentDiv.children, actionMod.gmailActionButtonView.getElement())) {
          actionParentDiv.insertBefore(
            actionMod.gmailActionButtonView.getElement(),
            actionParentDiv.firstChild
          );
        }
        this._getImageFixer().emit();
      }
    });
  }

  addAttachmentIcon(opts: Object) {
    if (!this._elements.length) {
      console.warn('addAttachmentIcon called on destroyed thread row');
      return;
    }
    const getImgElement = _.once(() => {
      const img = document.createElement('img');
      img.src = 'images/cleardot.gif';
      return img;
    });
    var added = false;
    var currentIconUrl;

    var prop: Kefir.Stream = kefirCast(Kefir, opts).toProperty();
    prop.combine(this._getRefresher(), identity).takeUntilBy(this._stopper).onValue(opts => {
      if (!opts) {
        if (added) {
          getImgElement().remove();
          added = false;
        }
      } else {
        const img = getImgElement();
        if(opts.tooltip){
          img.setAttribute('data-tooltip', opts.tooltip);
        }
        else{
          img.removeAttribute('data-tooltip');
        }

        img.className =
          'inboxsdk__thread_row_addition inboxsdk__thread_row_attachment_icon ' +
          (opts.iconClass || '');
        if (currentIconUrl != opts.iconUrl) {
          img.style.background = opts.iconUrl ? "url("+opts.iconUrl+") no-repeat 0 0" : '';
          currentIconUrl = opts.iconUrl;
        }

        var attachmentDiv = this._elements[0].querySelector('td.yf.xY');
        if (!attachmentDiv.contains(img)) {
          attachmentDiv.appendChild(img);
          added = true;
          this._expandColumn('col.yg', attachmentDiv.children.length*16);
          if (this._elements.length > 1) {
            this._fixDateColumnWidth();
          }
        }
      }
    });
  }

  _fixDateColumnWidth() {
    asap(() => {
      if (!this._elements.length) return;

      const dateContainer = this._elements[0].querySelector('td.xW, td.yf > div.apm');
      if (!dateContainer) return;
      const visibleDateSpan = dateContainer.querySelector('.inboxsdk__thread_row_custom_date') ||
        dateContainer.firstElementChild;

      // Attachment icons are only in the date column in vertical preivew pane.
      const dateColumnAttachmentIconCount = this._elements[0].querySelectorAll('td.yf > img').length;
      this._expandColumn('col.xX',
        visibleDateSpan.offsetWidth + 8 + 2 + 20 + dateColumnAttachmentIconCount*16);
    });
  }

  replaceDraftLabel(opts: Object) {
    if (!this._elements.length) {
      console.warn('replaceDraftLabel called on destroyed thread row');
      return;
    }
    let labelMod;
    let draftElement, countElement;
    const prop: Kefir.Stream = kefirCast(Kefir, opts).toProperty();
    prop.combine(this._getRefresher(), identity).takeUntilBy(this._stopper).onValue(opts => {
      const originalLabel = this._elements[0].querySelector('td > div.yW');
      const recipientsContainer = originalLabel.parentElement;
      if (!recipientsContainer) throw new Error("Should not happen");

      if (!opts) {
        if (labelMod) {
          labelMod.remove();
          this._modifications.replacedDraftLabel.claimed.splice(
            this._modifications.replacedDraftLabel.claimed.indexOf(labelMod), 1);
          labelMod = null;
        }
      } else {
        opts = _.assign({count: 1}, opts);

        if (!labelMod) {
          labelMod = this._modifications.replacedDraftLabel.unclaimed.shift();
          if (!labelMod) {
            labelMod = {
              el: _.assign(document.createElement('span'), {className: 'inboxsdk__thread_row_custom_draft_label'}),
              remove() {
                this.el.remove();
              }
            };
          }
          this._modifications.replacedDraftLabel.claimed.push(labelMod);
        }

        const needToAdd = !_.includes(recipientsContainer.children, labelMod.el);

        if (needToAdd || !draftElement) {
          labelMod.el.innerHTML = originalLabel.innerHTML;
          draftElement = labelMod.el.querySelector('font');
          if (!draftElement) {
            return;
          }
          draftElement.classList.add('inboxsdk__thread_row_custom_draft_part');
          if (draftElement.nextSibling) {
            draftElement.nextSibling.remove();
          }
          countElement = _.assign(document.createElement('span'), {
            className: 'inboxsdk__thread_row_custom_draft_count'});
          labelMod.el.appendChild(countElement);
        }

        draftElement.textContent = opts.text;
        countElement.textContent = opts.count !== 1 ? ` (${opts.count})` : '';

        if (needToAdd) {
          recipientsContainer.insertBefore(labelMod.el, originalLabel);
        }
      }
    });
  }

  replaceDate(opts: Object) {
    if (!this._elements.length) {
      console.warn('replaceDate called on destroyed thread row');
      return;
    }
    let dateMod;
    const prop: Kefir.Stream = kefirCast(Kefir, opts).toProperty();
    prop.combine(this._getRefresher(), identity).takeUntilBy(this._stopper).onValue(opts => {
      const dateContainer = this._elements[0].querySelector('td.xW, td.yf > div.apm');
      const originalDateSpan = dateContainer.firstElementChild;

      if (!opts) {
        if (dateMod) {
          dateMod.remove();
          this._modifications.replacedDate.claimed.splice(
            this._modifications.replacedDate.claimed.indexOf(dateMod), 1);
          dateMod = null;
        }
      } else {
        if (!dateMod) {
          dateMod = this._modifications.replacedDate.unclaimed.shift();
          if (!dateMod) {
            dateMod = {
              el: _.assign(document.createElement('span'), {className: 'inboxsdk__thread_row_custom_date'}),
              remove() {
                this.el.remove();
              }
            };
          }
          this._modifications.replacedDate.claimed.push(dateMod);
        }

        dateMod.el.textContent = opts.text;
        if (opts.tooltip) {
          dateMod.el.setAttribute('data-tooltip', opts.tooltip);
          dateMod.el.setAttribute('aria-label', opts.tooltip);
        } else {
          dateMod.el.removeAttribute('data-tooltip');
          dateMod.el.removeAttribute('aria-label');
        }
        dateMod.el.style.color = opts.textColor || '';

        if (!_.includes(dateContainer.children, dateMod.el)) {
          dateContainer.insertBefore(dateMod.el, dateContainer.firstChild);
        }

        this._fixDateColumnWidth();
      }
    });
  }

  getEventStream(): Kefir.Stream {
    return this._stopper;
  }

  getStopper(): Kefir.Stream {
    return this._stopper;
  }

  getSubject(): string {
    if (this._elements.length > 1) {
      return this._elements[1].querySelector('div.xS div.xT div.y6 > span[id]').textContent;
    } else {
      return this._elements[0].querySelector('td.a4W div.xS div.xT div.y6 > span[id]').textContent;
    }
  }

  getDateString(): string {
    return this._elements[0].querySelector(
      'td.xW > span[title]:not(.inboxsdk__thread_row_custom_date), td.yf.apt > div.apm > span[title]:not(.inboxsdk__thread_row_custom_date)'
    ).title;
  }

  _threadIdReady(): boolean {
    return !!this._getThreadID();
  }

  _getThreadID(): ?string {
    if (this._cachedThreadID) {
      return this._cachedThreadID;
    }

    const threadID = this._driver.getThreadRowIdentifier()
      .getThreadIdForThreadRow(this, this._elements);
    if (threadID) {
      this._cachedThreadID = threadID;
    }
    return threadID;

  }

  getThreadID(): string {
    const threadID = this._getThreadID();
    if (!threadID) {
      throw new Error("Should not happen: thread id was null");
    }
    return threadID;
  }

  getDraftID(): Promise<?string> {
    return this._driver.getThreadRowIdentifier().getDraftIdForThreadRow(this);
  }

  getVisibleDraftCount(): number {
    return this.getCounts().draftCount;
  }

  getVisibleMessageCount(): number {
    return this.getCounts().messageCount;
  }

  getContacts(): Contact[] {
    const senderSpans = this._elements[0].querySelectorAll('[email]');

    return _.chain(senderSpans)
            .map((span) => ({
              emailAddress: span.getAttribute('email'),
              name: span.getAttribute('name')
            }))
            .uniq((contact) => contact.emailAddress)
            .value();
  }

  isSelected(): boolean {
    return !!this._elements[0].querySelector('div[role=checkbox][aria-checked=true]');
  }

  _getLabelParent(): HTMLElement {
    return this._elements.length > 1 ?
            this._elements[ this._elements.length === 2 ? 0 : 2 ].querySelector('div.apu') :
            this._elements[0].querySelector('td.a4W div.xS div.xT');
  }

  _getImageFixer(): Kefir.Bus {
    let imageFixer = this._imageFixer;
    if(!imageFixer){
      imageFixer = this._imageFixer = kefirBus(); // emit into this to queue an image fixer run
    }

    return imageFixer;
  }

  _getImageFixerTask(): Kefir.Stream {
    let imageFixerTask = this._imageFixerTask;
    if(!imageFixerTask){
      imageFixerTask = this._imageFixerTask =
        this._getImageFixer()
          .bufferBy(this._getImageFixer().flatMap(x => delayAsap()))
          .filter(x => x.length > 0)
          .map(x => null)
          .takeUntilBy(this._stopper);
    }

    return imageFixerTask;
  }

  _subscribeTextFixer() {
    if(this._didSubscribeTextFixerRun) return;

    // Work around the text-corruption issue on Chrome on retina displays that
    // happens when images are added to the row.
    this._getImageFixerTask().onValue(() => {
      const tr = this._elements[0];
      const computedBgColor = window.getComputedStyle(tr).backgroundColor;
      tr.style.backgroundColor = tweakColor(computedBgColor);
      setTimeout(() => {
        tr.style.backgroundColor = '';
      }, 0);
    });

    this._didSubscribeTextFixerRun = true;
  }

  _getWatchElement(): HTMLElement {
    return this._elements.length === 1 ?
      this._elements[0] : (this._elements[0].children[2]: any);
  }

  _getRefresher(): Kefir.Stream {
    // Stream that emits an event after whenever Gmail replaces the ThreadRow DOM
    // nodes. One time this happens is when you have a new email in your inbox,
    // you read the email, return to the inbox, get another email, and then the
    // first email becomes re-rendered.
    // Important: This stream is only listened on if some modifier method
    // (like addLabel) is called. If none of those methods are called, then the
    // stream is not listened on and no MutationObserver ever gets made, saving
    // us a little bit of work.
    let refresher = this._refresher;
    if(!refresher){
      refresher = this._refresher = makeMutationObserverChunkedStream(this._getWatchElement(), {
        childList: true
      }).map(()=>null).takeUntilBy(this._stopper).toProperty(() => null);
    }

    return refresher;
  }

  _getSubjectRefresher(): Kefir.Stream {
    let subjectRefresher = this._subjectRefresher;
    if(!subjectRefresher){
      if (this._isVertical) {
        subjectRefresher = this._subjectRefresher = Kefir.constant(null);
      } else {
        const watchElement = this._getWatchElement();
        const subjectElement = watchElement.querySelector('.y6');
        subjectRefresher = this._subjectRefresher = makeMutationObserverChunkedStream(subjectElement, {
            childList: true
          })
          .merge(
            makeMutationObserverChunkedStream(watchElement, {
              attributes: true, attributeFilter: ['class']
            })
          )
          .map(()=>null)
          .takeUntilBy(this._stopper)
          .toProperty(() => null);
      }
    }

    return subjectRefresher;
  }
}

assertInterface(GmailThreadRowView.prototype, ThreadRowViewDriver);

export default defn(module, GmailThreadRowView);

export function removeAllThreadRowUnclaimedModifications(){
    // run in a setTimeout so that the thread rows get destroyed
    // and populate the unclaimed modifications
    setTimeout(() => {

      const modifiedRows = document.querySelectorAll('.inboxsdk__thread_row');
      _.each(modifiedRows, row => {

        const modifications = cachedModificationsByRow.get(row);
        if(modifications){
          _removeThreadRowUnclaimedModifications(modifications);
        }

      });

    }, 15);


}



function _removeThreadRowUnclaimedModifications(modifications){
  for (let ii=0; ii<modifications.label.unclaimed.length; ii++) {
    const mod = modifications.label.unclaimed[ii];
    //console.log('removing unclaimed label mod', mod);
    mod.remove();
  }
  modifications.label.unclaimed.length = 0;
  for (let ii=0; ii<modifications.button.unclaimed.length; ii++) {
    const mod = modifications.button.unclaimed[ii];
    //console.log('removing unclaimed button mod', mod);
    mod.remove();
  }
  modifications.button.unclaimed.length = 0;
  for (let ii=0; ii<modifications.image.unclaimed.length; ii++) {
    const mod = modifications.image.unclaimed[ii];
    //console.log('removing unclaimed image mod', mod);
    mod.remove();
  }
  modifications.image.unclaimed.length = 0;

  for (let ii=0; ii<modifications.replacedDate.unclaimed.length; ii++) {
    const mod = modifications.replacedDate.unclaimed[ii];
    //console.log('removing unclaimed replacedDate mod', mod);
    mod.remove();
  }
  modifications.replacedDate.unclaimed.length = 0;

  for (let ii=0; ii<modifications.replacedDraftLabel.unclaimed.length; ii++) {
    const mod = modifications.replacedDraftLabel.unclaimed[ii];
    mod.remove();
  }
  modifications.replacedDraftLabel.unclaimed.length = 0;
}
