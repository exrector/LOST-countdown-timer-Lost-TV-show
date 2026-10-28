#import <Foundation/Foundation.h>

// Swift cannot catch NSException. AVAudioPlayerNode.play raises one when Core Audio
// rebuilds the output graph underneath a running engine (Apple voice processing
// starting on the same output does exactly that); uncaught, it aborts the station.
// Returns nil on success, otherwise the exception reason.
NSString * _Nullable LOSTCatchException(void (NS_NOESCAPE ^ _Nonnull block)(void));
