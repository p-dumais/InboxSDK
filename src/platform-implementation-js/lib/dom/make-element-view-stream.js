/* @flow */
//jshint ignore:start

var Kefir = require('kefir');

// Built for flatMapping a stream from makeElementChildStream(). This doesn't
// call makeElementChildStream() here -- you can call that yourself so you can
// filter/map/merge that stream however you want before passing it here. Make
// sure that this stream (and therefore the source makeElementChildStream) stops
// being listened to at some point to trigger the destruction of the views!
type View = {destroy: () => void};
type TimedElement = {el: HTMLElement, removalStream: Kefir.Stream};

export default function makeElementViewStream<T: View>(viewFn: (el: HTMLElement) => ?T): (event: TimedElement) => Kefir.Stream<T> {
  return function(event) {
    var mview = viewFn(event.el);
    if (mview) {
      var view = mview;
      event.removalStream.onValue(function() {
        view.destroy();
      });
      return Kefir.constant(view);
    } else {
      return Kefir.never();
    }
  };
}
