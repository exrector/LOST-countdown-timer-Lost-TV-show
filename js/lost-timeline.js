// Original LOST timing. Seconds are elapsed seconds from the station's monotonic clock.
(function(root, factory) {
    var timeline=factory();
    if(typeof module==='object' && module.exports)module.exports=timeline;
    else root.LostTimeline=timeline;
})(typeof globalThis!=='undefined'?globalThis:this,function() {
    var failure={zeroHold:2,glyphs:12,glyphLocks:[10.5,12,7,6,8.5],voiceStart:13,voiceStop:48,white:58,restart:68};
    return {
        duration:108*60,
        failure:failure,
        // The original shows zero for two seconds before rolling the glyphs.
        // White appears 58s after glyphs, holds 10s, then reset starts.
        failureDuration:failure.zeroHold+failure.restart,
        countdownSounds:function(left) {
            var sounds=[];
            if(left<0)return sounds;
            if(left%60===0 || left<240)sounds.push('tick');
            if(left<240 && left>60 && left%2===0)sounds.push('beep');
            if((left<=60 && left%2===0) || left<10)sounds.push('alarm');
            return sounds;
        }
    };
});
