/* @flow */

import _ from 'lodash';
import $ from 'jquery';
import RSVP from 'rsvp';

import simulateClick from '../../../../lib/dom/simulate-click';
import setValueAndDispatchEvent from '../../../../lib/dom/set-value-and-dispatch-event';

import type GmailComposeView from '../gmail-compose-view';

export default function insertLinkIntoBody(gmailComposeView: GmailComposeView, text: string, href: string): ?HTMLElement {
	return _insertLinkIntoBody(gmailComposeView, text, href);
}

function _insertLinkIntoBody(gmailComposeView, text, href){
	gmailComposeView.focus();

	var composeBodyElement = $(gmailComposeView.getBodyElement());
	composeBodyElement.focus();

	simulateClick(gmailComposeView.getInsertLinkButton());

	if($('#linkdialog-text').length === 0){
		return;
	}

	var originalText = $('#linkdialog-text').val();
	setValueAndDispatchEvent($('#linkdialog-onweb-tab-input')[0], href, 'input');

	simulateClick($('button[name=ok]')[0]);

	var $link = composeBodyElement.find('a[href="'+href+'"]');

	if(originalText.length === 0){
		$link.text(text);
	}

	return $link[0];
}
