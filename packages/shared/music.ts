export interface MusicTrack { id:string; name:string; url:string; duration:number; bpm:number; mood:string; tags:string[]; source:string; license:string }
export interface BgmSettings { enabled:boolean; trackId:string; volume:number; sourceIn:number; start:number; end:number; fadeIn:number; fadeOut:number; ducking:boolean }
export interface MusicRecommendation { tracks:(MusicTrack & {reason:string})[]; suitable:boolean; summary:string; mood:string; speechRate:number; cutRate:number }
