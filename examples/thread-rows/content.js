var inboxSDK = new InboxSDK('thread-rows');

function log() {
	console.log.apply(console, ['thread-rows'].concat(Array.prototype.slice.call(arguments)));
}

var i = 0;
inboxSDK.Mailbox.registerThreadRowViewHandler(function(threadRowView) {
	console.log('threadRowView', threadRowView.getThreadId(), threadRowView.getSubject());
	threadRowView.addLabel(Bacon.repeatedly(10000, [
		{text:'A'},
		{text:'B', textColor: 'blue'}
	]).toProperty({text:'0'}));
	threadRowView.addLabel({
		text:'a'+(i++),
		color:'white',
		textColor:'blue'
	});
	threadRowView.addAttachmentIcon(Bacon.repeatedly(2000, [
		{
			iconUrl: 'https://ssl.gstatic.com/mail/sprites/general_black-16bf964ab5b51c4b7462e4429bfa7fe8.png',
			title: 'thing'
		},
		{
			iconUrl: 'https://ssl.gstatic.com/ui/v1/icons/mail/gplus.png',
			title: 'blah blah'
		}
	]));
	threadRowView.replaceDate({text: Math.random() > 0.5 ? 'Returning in: 6 months' : 'aaa', textColor: 'green', title: 'beep'});

	var buttonBus = new Bacon.Bus();
	threadRowView.addButton(buttonBus.toProperty());
	var item = {
		iconUrl: 'https://mailfoogae.appspot.com/build/images/listIndicatorDark.png',
		className: 'buttonLight',
		hasDropdown: true,
		onClick: function(event) {
			delete item.className;
			item.iconUrl = 'https://mailfoogae.appspot.com/build/images/listIndicator.png';
			item.hasDropdown = false;

			if (event.dropdown) {
				event.dropdown.el.textContent = 'aaaaaaaa';
			}

			console.log('threadrow got click event', event, threadRowView);
			buttonBus.plug(Bacon.later(1000, null));
			buttonBus.plug(Bacon.later(2000, item));
		}
	};
	buttonBus.push(item);
	threadRowView.addButton({
		iconUrl: 'https://mailfoogae.appspot.com/build/images/reminder.png',
		hasDropdown: true,
		onClick: function(event) {
			event.dropdown.el.innerHTML += 'beep <b>beep</b><br>aaa<br>aaaaaa';
			event.dropdown.on('unload', function() {
				console.log('thread row button dropdown closed');
			});
			setTimeout(function() {
				event.dropdown.close();
			}, 10000);
		}
	});
});
