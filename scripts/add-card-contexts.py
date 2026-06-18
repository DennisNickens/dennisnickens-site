#!/usr/bin/env python3
"""
Adds a `context` field to every card in cards.json. Run once.
Voice approved by Dennis via three sample contexts in chat.

Each context is two short paragraphs, no em dashes, helps the couple
see what the question is pointing at without giving them the answer.
"""

import json
import os
import sys

CARDS_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "games", "lovers-quest", "cards.json"
)

CONTEXTS = {
    # ---------------- INTIMACY (1-12) ----------------
    1: (
        "This one asks about a specific moment, not a general feeling. Think about a recent time where your spouse saw something in you that no one else would have caught. Not what they said about it. What you felt when you realized they saw it.\n\n"
        "The point isn't to find the perfect example. It's to put words to what being known by your spouse actually feels like, so they know which way to keep moving."
    ),
    2: (
        "People remember which questions their spouse never asks. The absence of a question can land harder than a hard conversation. This is your chance to name what you've been waiting to be asked, without making your spouse feel like they should have known.\n\n"
        "Speak it softly. The point isn't to indict them for not asking. It's to give them the question, so they can ask it now and going forward."
    ),
    3: (
        "There's a difference between feeling tolerated, feeling appreciated, and feeling actually wanted. Wanted means they chose you in a moment they could have chosen something else. Think about a recent time that landed for you that way.\n\n"
        "Name the specifics of what they did. The HOW matters as much as the WHAT. Naming the specifics teaches them how to do it again."
    ),
    4: (
        "Long marriages slowly stop noticing. The parts of you they fell in love with don't disappear, but their attention to them can. This question asks you to point at something specific, not to complain.\n\n"
        "A trait, a gift, a softness, a strength. Something that's still there but isn't being seen lately. The point is to put it back on their radar so they can choose to look again."
    ),
    5: (
        "Right now, not in your wedding video. The way they love you has changed over the years, and so has the way you love them. This question asks you to describe the actual texture of being loved by them today.\n\n"
        "Safe? Quiet? Distracted? Steady? Whatever the honest word is. They cannot adjust what you do not name."
    ),
    6: (
        "Closeness sometimes asks for words. Sometimes it asks for something else entirely. A look. A hand on the back. A few minutes on the couch with no agenda. This question asks you to describe the non-verbal language that actually reaches you.\n\n"
        "Most spouses default to talking when their partner needs something else. Tell them what the something else looks like."
    ),
    7: (
        "Marriages lose things slowly, sometimes without noticing. Some habits and rhythms between you are sacred and worth protecting before they fade.\n\n"
        "Name one. Not the obvious one. The small specific one only the two of you would notice. The point is to put a stake in the ground so neither of you accidentally lets it go."
    ),
    8: (
        "Physical intimacy can be about a lot of things. Sometimes it's just release. Sometimes it's connection. Sometimes one person is fully present and the other is somewhere else.\n\n"
        "This asks for a specific recent moment where you both knew it was about the two of you, not just the act. If you can't think of one, that's worth saying too. Without blame."
    ),
    9: (
        "Intimacy isn't only physical, and the most intimate moments between spouses sometimes happen fully clothed in the kitchen. A conversation that went somewhere unexpected. A look across the room when something hard was happening. A silence that meant more than words.\n\n"
        "Name a moment, and what made it land that way for you."
    ),
    10: (
        "This is a both-and question. Marriages evolve, and what you miss is real, and what you've gained is real. Both halves matter. Don't let yourself only answer one.\n\n"
        "Name one thing from earlier that you wish was still part of how you love each other. Then name one thing that's developed since that you would not trade back."
    ),
    11: (
        "Every person has rooms in them they keep closed. Some of those walls are old self-protection. Some are loyalty to a private version of yourself.\n\n"
        "This asks you to name one of them honestly, without obligating yourself to take the wall down tonight. Then describe what would help you eventually let your spouse in. Naming the wall is the first step. Removing it is a separate conversation."
    ),
    12: (
        "Spouses develop a fixed picture of each other over the years. Sometimes that picture stops updating. There's a version of you that exists now that they might not be tracking. A change. A growth. A wound you're still working on.\n\n"
        "Tell them what you wish their picture of you included. The point isn't to argue with their view, it's to help them see you as you actually are today."
    ),

    # ---------------- TRUST (13-24) ----------------
    13: (
        "Safety in a marriage isn't physical safety, it's permission to bring the whole self to the table. Most spouses still edit themselves a little, even after years.\n\n"
        "Think about what you'd stop editing if you knew it would land softly. Then describe what your spouse would need to do (or stop doing) for that to be the case. Be specific. Vague safety is hard to provide."
    ),
    14: (
        "Long marriages accidentally develop \"things one of us is handling.\" Sometimes that's fine. Sometimes it's a weight one of you has been carrying that the other one would have happily helped with if they'd known.\n\n"
        "This is your chance to put that thing on the table. Not as a complaint. As an invitation to share the load."
    ),
    15: (
        "Big trust breaks get talked about. Small ones get buried, and over time they add up to something bigger than the original violation.\n\n"
        "This is your chance to surface one of those small ones safely. Not to assign blame. To clear the air. Speak it as something you've been carrying, not something they did to you. The goal is for both of you to know what's been sitting under the surface, so you can decide together what to do with it."
    ),
    16: (
        "The trust required in early marriage isn't the same as the trust required ten years in. As the seasons shift (kids, jobs, health, callings), what you need to feel safe with each other shifts too.\n\n"
        "This asks you to describe what trust LOOKS like for you right now, not what it looked like five years ago. The form of it has probably changed. Name the current shape."
    ),
    17: (
        "\"Be more dependable\" is too vague to act on. This question asks for the specific area and the specific behavior.\n\n"
        "A morning rhythm. A weekly check-in. Following through on a small recurring thing. Make it concrete enough that your spouse can do it on purpose. Reliability is built in specifics, not in general intentions."
    ),
    18: (
        "There's a difference between thoughts you tell your spouse and thoughts you keep to yourself because you've decided they can't hold them.\n\n"
        "This asks you to describe what they'd have to do (or stop doing) for the held-back thoughts to feel safe to share. Often it's about their reaction, not their advice. They need to know that before they can offer it."
    ),
    19: (
        "Lack of trust usually has fear sitting under it. Fear of being judged. Fear of being misunderstood. Fear of opening something that can't be closed.\n\n"
        "This asks you to name the fear, not just the lack of trust. Once your spouse can see the fear, they can speak to it. Without the fear named, all they can do is feel rejected."
    ),
    20: (
        "Money decisions are some of the easiest places to silently disagree and never bring it up. A purchase you went along with. A budget choice you didn't push back on. A long-term plan you have private doubts about.\n\n"
        "This is your chance to name it honestly, without revisiting the decision yet. First put the truth on the table. The decision itself can be revisited later if it needs to be."
    ),
    21: (
        "Marriages span seasons, and both spouses change. Sometimes a change is good. Sometimes it makes the other person wonder where the person they married went.\n\n"
        "This is a hard question on purpose. Speak it without weaponizing it. The goal isn't to accuse them of being a stranger, it's to name what's shifted so the two of you can decide together whether to lean in or lean back."
    ),
    22: (
        "Rebuilt trust often has a residue. Even when you've decided to forgive, a small part of you stays alert. This asks you to name that residue honestly.\n\n"
        "Then describe what they could do (or what time they'd need to demonstrate consistency) for the residue to dissolve. Speak it as information they can act on, not as an accusation."
    ),
    23: (
        "Some weights get carried alone because we've decided our spouse can't bear them. Sometimes that's protection. Sometimes that's a quiet judgment about who they are.\n\n"
        "This question invites you to name where you've made that call, and to consider whether you're underestimating them. They may be ready to carry more than you've given them credit for."
    ),
    24: (
        "Spouses can be on each other's side in general and still leave moments where the other one doesn't feel it.\n\n"
        "This asks for a specific present-tense action. Not a year-long change. One thing they could do today, this week, that would land in your body as \"they have my back.\" Make it concrete. Make it something they could actually do."
    ),

    # ---------------- PURPOSE (25-36) ----------------
    25: (
        "Marriage is a partnership and most partnerships have a build, a shared assignment, a thing the two of you are uniquely positioned to do.\n\n"
        "This asks you to put words to what you sense God is asking of you AS A COUPLE, not just as individuals. It doesn't have to be big. It doesn't have to be public. It just has to be true."
    ),
    26: (
        "This question doesn't ask for hope, it asks for trajectory. Where does the math of your current habits, rhythms, and choices actually land you in a decade?\n\n"
        "Be honest. If the answer is somewhere you don't want to be, that's information. If it's somewhere you do want to be, that's confirmation. Either way, name it specifically."
    ),
    27: (
        "There's an assignment with your name on it that nobody else can fulfill the same way. The combination of who you both are, what you've been through, who you have access to, what you've learned makes a unique offering.\n\n"
        "This asks you to name what that is, even if it feels presumptuous. Especially if it feels presumptuous."
    ),
    28: (
        "Most couples can name something they've felt called to that they haven't yet acted on. Fear, timing, finances, doubt.\n\n"
        "This is your chance to name it out loud, even if you can't act on it tonight. Naming it is the first step toward stepping into it. Don't let another season pass with this one unspoken."
    ),
    29: (
        "One spouse can be sensing something the other one hasn't fully seen or supported yet. Maybe a calling, a ministry, a career direction, a personal growth path.\n\n"
        "This asks you to name where that gap is, not as a grievance, but as a request for them to look again. Sometimes spouses just need to know what they've been missing in order to step in."
    ),
    30: (
        "This asks two questions. First, picture the version of the two of you that you most want to grow into. Be specific. Not \"happier,\" but a real picture.\n\n"
        "Then name what's currently between you and that version. A pattern. A fear. A choice you keep avoiding. The future version is reachable, but only if you name the obstacle and decide to do something about it."
    ),
    31: (
        "Don't think too hard. The first image is usually the truest one. It might be your kids. It might be a stage. It might be a quiet meal table with people you've poured into.\n\n"
        "Whatever flashes first, describe it. Then describe what would have to be true in your marriage today for that image to actually become real."
    ),
    32: (
        "Some callings come to one spouse first, and they sit on them because they're afraid of what it would mean for the marriage. A move. A career shift. A ministry. A change in lifestyle.\n\n"
        "This is your chance to put it on the table. Not as a decision. As something you've been carrying alone that you need help thinking about with the person you're going to do it with."
    ),
    33: (
        "Marriages eventually face moments where you can't both have what you sense. Whose dream takes priority? Whose calling waits?\n\n"
        "This question asks you to think about your decision-making process BEFORE you're in the heat of it. What values would you use? What conversation would you have? Building the framework now makes the actual decision easier later."
    ),
    34: (
        "Most couples have at least one drain they suspect is misaligned but haven't named. A commitment, a relationship, a subscription, a habit.\n\n"
        "This is the chance to name it honestly without yet deciding what to do about it. Sometimes naming is enough to start shifting it."
    ),
    35: (
        "God speaks. Sometimes to one spouse, sometimes to both. Sometimes the one who heard kept it to themselves because they weren't sure how to share it.\n\n"
        "This asks you to bring that word into the room. Not as a debate. As something the two of you need to hold together, since the marriage was the subject."
    ),
    36: (
        "Sometimes one spouse sees a calling on the other one before the other one is ready to admit it's there.\n\n"
        "This flips the question. You're asking your spouse what they've been seeing in you that you haven't been willing to claim yet. Listen carefully. They may be naming something true. The fact that you've resisted it doesn't mean it isn't yours."
    ),

    # ---------------- CONFLICT (37-48) ----------------
    37: (
        "Healthy couples still fight. The difference is the direction of the fight.\n\n"
        "This asks you to describe what fighting FOR each other actually looks like in real time. Specific behaviors. A pause before reacting. A phrase that signals you're both on the same team. The framework only works if you've defined it in advance."
    ),
    38: (
        "Conflict in a marriage is usually patterned. The same dance, the same triggers, the same escalation. This asks you to name the pattern from your perspective, not to assign blame.\n\n"
        "Once both of you can see the same pattern, you can both interrupt it. Patterns are easier to break when both people know the choreography."
    ),
    39: (
        "In the middle of a fight, most people don't know how to ask for what they need. They need space and ask for distance. They need to be held and ask for an apology.\n\n"
        "This asks you to name, in calm, what you actually need in heat. Then your spouse will know what to give next time."
    ),
    40: (
        "Some behaviors shut your spouse down before your words even land. Tone, volume, body language, a phrase that triggers them.\n\n"
        "This asks you to name one specific thing they do that closes you off. Not the whole list. One thing. They can address one thing."
    ),
    41: (
        "Most marriages carry at least one wound that got bandaged but never fully closed. It comes up sideways in unrelated fights.\n\n"
        "This is your chance to name it AND describe what healing it would actually look like. Not just \"an apology.\" The actual texture of what closure would feel like for you."
    ),
    42: (
        "A single phrase, said at the right moment, can de-escalate a fight. What's yours? Not what should be theirs.\n\n"
        "What's the line that, if your spouse said it to you mid-conflict, would let you exhale? Tell them. They cannot say what they don't know to say."
    ),
    43: (
        "Not all fights damage the marriage. Some of them actually deepen it. This asks you to think back to one that ended in more closeness than you started with.\n\n"
        "What was different about it? The timing? The honesty? The willingness to hear before responding? Naming what worked teaches you both how to do it again."
    ),
    44: (
        "Exhausted fights aren't real fights, but the damage from them is real.\n\n"
        "This asks you to name your spouse's exhaustion pattern (theirs, not yours) and offer an alternative behavior they could choose. Give them a script. \"When we're both tired and you do X, it lands harder. If you could Y instead, that would help.\" That's actionable."
    ),
    45: (
        "Most couples have one spouse who consistently makes the first move to reconcile. Sometimes that's their gift. Sometimes it's a habit that lets the other one off the hook.\n\n"
        "This asks you to look at the pattern honestly. Is it still working for both of you? Or is it time to redistribute the labor of repair?"
    ),
    46: (
        "Every marriage has at least one conversation both people know is needed and both people keep stepping around.\n\n"
        "This is the chance to name it without yet having it. Just put the topic on the table. The actual conversation can happen later. Naming what you're avoiding is half the work of stopping the avoidance."
    ),
    47: (
        "We all bring our families into our marriages. Some of those patterns are gifts. Some of them are landmines.\n\n"
        "This asks your spouse to name a specific pattern from your family of origin that they wish you would recognize on your own, before it has to be pointed out for the hundredth time. Hear them. Don't defend the family. Listen to what they're saying about the pattern."
    ),
    48: (
        "Silence in marriage means many things, and most spouses misread it at least some of the time.\n\n"
        "This asks you to help your spouse decode yours. When does your silence mean \"give me room?\" When does it mean \"come find me?\" Without the decoder, they'll guess wrong half the time and you'll feel unseen for it."
    ),

    # ---------------- GRACE (49-60) ----------------
    49: (
        "Grace isn't a general topic, it's a specific present-tense need. There's a place in your life right now where you need your spouse to extend you something softer than what you're getting.\n\n"
        "Maybe in how they react to your mistakes. Maybe in how patient they are with your growth. Maybe in how they hold a struggle of yours. Name the place. Be specific."
    ),
    50: (
        "Some weights we put on ourselves can't be put down without help. A failure, a mistake, a season we're ashamed of.\n\n"
        "This is your chance to name yours, not to be absolved, but so your spouse can stand with you in the carrying. Sometimes that's all it takes for the weight to start to shift."
    ),
    51: (
        "This is a thank-you in question form. There was a moment where your spouse extended you grace you didn't expect, and something in you shifted because of it.\n\n"
        "Name it. Tell them what it did for you. The point isn't to pay them back. It's to let them know that the grace landed somewhere real."
    ),
    52: (
        "This is the harder direction. When you've been the one who hurt them, you need a specific kind of grace from them, not generic forgiveness but a particular shape of welcome back.\n\n"
        "This asks you to describe what that looks like FOR YOU. Then your spouse will know how to offer it the next time you mess up, which (let's be honest) is coming."
    ),
    53: (
        "Most spouses have something they reflexively apologize for that their partner actually loves about them, or at least doesn't mind.\n\n"
        "This flips the script. Listen for what your spouse names. Their answer is permission to stop apologizing. Receive it."
    ),
    54: (
        "Softness in marriage isn't free. It costs energy, especially when the other person is going through something hard.\n\n"
        "This asks you to name what staying soft is currently costing you, and what your spouse could do to lighten that cost. Soft isn't sustainable on its own. It needs support to keep being soft."
    ),
    55: (
        "Different responses from a spouse produce different outcomes. Some make you defensive. Some make you ashamed. Some make you want to grow.\n\n"
        "This asks you to describe what kind of response actually leads to the growth your spouse wants for you. Then they have a roadmap for the next time you mess up."
    ),
    56: (
        "Grace on a good day is easy. Grace on a hard day is the actual practice.\n\n"
        "This asks you to describe what grace looks like specifically on the days when neither of you wants to give it. The minimum viable version. The version that gets you through without becoming someone who withholds. Define it now, while you're calm. Use it when you're not."
    ),
    57: (
        "Some grace gets extended quietly. Your spouse forgave you for something and never mentioned it.\n\n"
        "This is the chance to surface one of those, not to make them feel bad, but to acknowledge what's already been done. Then the air clears. Some things don't need to be re-litigated. They just need to be named."
    ),
    58: (
        "Sometimes one spouse is holding back forgiveness or softness, and the other one is quietly waiting for it. This is hard.\n\n"
        "You're asked to look at where you've been withholding, name it honestly, and notice what it's been costing your spouse to wait. This isn't a request to release it tonight. It's a request to admit it's been held."
    ),
    59: (
        "Receiving grace is harder than extending it for a lot of people. There's pride in it.\n\n"
        "This asks you to consider where you've been refusing your spouse's grace in order to prove you can do it on your own. Then describe what fully receiving would look like. It's not weakness to take what's offered."
    ),
    60: (
        "Sometimes the marriage as a thing needs grace too. Not from one spouse to the other. From both of you to the relationship itself.\n\n"
        "Maybe patience while it's adjusting. Maybe mercy during a hard chapter. This asks you to name what the marriage needs from both of you collectively, not what either of you needs individually."
    ),

    # ---------------- LEGACY (61-72) ----------------
    61: (
        "Your marriage is going to be a story someone tells eventually. To your kids. To other couples. To people who watched it.\n\n"
        "This asks you to describe the version of that story you want told. Not the polished version. The true version that includes what you want the takeaway to be. Name it now and you have something to live toward."
    ),
    62: (
        "One sentence forces you to choose. Not five things. The one thing you most want people to remember about how you two loved each other.\n\n"
        "Say it out loud. Then notice if your current life is making that sentence true. If not, what would need to shift?"
    ),
    63: (
        "Marriages set standards whether they mean to or not. Your kids, your nieces and nephews, the younger couples in your circle. They're watching how you handle each other.\n\n"
        "This asks you to name the one thing you most want them to take as the standard. Then you can be intentional about modeling it."
    ),
    64: (
        "Some chapters were hard but they built something between you that couldn't have been built any other way.\n\n"
        "This asks you to name one. Not to romanticize the hard part. To recognize what the hard chapter actually gave you that you wouldn't give back."
    ),
    65: (
        "You're going to be old together. That's the assumption this question is built on. The season you're in right now will look very different in 30 years.\n\n"
        "So zoom out. What about this exact chapter (the kids being young, the business being new, the season being hard, whatever it is) do you want your future selves to remember? Not what you'll be proud of. What you'll be glad you didn't miss."
    ),
    66: (
        "There's a prayer you keep coming back to about your marriage. Maybe protection. Maybe peace. Maybe direction.\n\n"
        "This asks you to name it, then ask what it would look like to live as if God were already answering it. Sometimes the prayer is the assignment."
    ),
    67: (
        "This question is heavy on purpose. It asks you to think about what you'd want your spouse to carry forward about what the marriage meant to you, if you weren't here to keep telling them.\n\n"
        "Don't rush past this one. The answer is what makes the marriage holy."
    ),
    68: (
        "Sometimes the people watching see what the people inside don't. Your marriage is already doing something for your siblings, your cousins, your parents, your kids.\n\n"
        "This asks you to consider what that legacy already is. Name it. Then decide if you want to lean into it on purpose."
    ),
    69: (
        "Children remember texture more than they remember events. They remember whether their parents touched each other in the kitchen, whether they laughed, whether they fought softly or loud.\n\n"
        "This asks you to name the specific texture you most want them to carry into their own marriages. Then make sure your house has it."
    ),
    70: (
        "Every honest marriage has a failure or a near-failure that became part of how it grew. Not the polished version. The one you'd actually tell a young couple if they asked.\n\n"
        "This asks you to name yours together. Then decide whether the two of you are ready to start telling that story to people who need to hear it."
    ),
    71: (
        "There's something spiritual you want to leave behind that you haven't yet built. A practice. A standard. A way of seeing God together.\n\n"
        "This asks you to name what's missing, and consider what would have to change for it to actually become part of your legacy. The legacy you leave is the legacy you build on purpose."
    ),
    72: (
        "Zoom out one more time. Look at the chapter you're currently in. Give it a title, the kind that captures what's true about this season for you both.\n\n"
        "Maybe it's \"The Hard Year.\" Maybe it's \"When We Finally Got Honest.\" Maybe it's \"The Beginning of the Build.\" Title it. Then ask what you want the next chapter to be called."
    ),
}


def main():
    if len(CONTEXTS) != 72:
        print(f"ERROR: expected 72 contexts, found {len(CONTEXTS)}", file=sys.stderr)
        sys.exit(1)

    with open(CARDS_PATH, "r") as f:
        data = json.load(f)

    if len(data["cards"]) != 72:
        print(f"ERROR: expected 72 cards in cards.json, found {len(data['cards'])}", file=sys.stderr)
        sys.exit(1)

    # Check for em dashes / en dashes (Dennis's non-negotiable rule)
    bad_chars = {"—": "em dash", "–": "en dash"}
    for cid, ctx in CONTEXTS.items():
        for ch, name in bad_chars.items():
            if ch in ctx:
                print(f"ERROR: context for card {cid} contains {name}", file=sys.stderr)
                sys.exit(1)

    for card in data["cards"]:
        cid = card["id"]
        if cid not in CONTEXTS:
            print(f"ERROR: no context written for card id {cid}", file=sys.stderr)
            sys.exit(1)
        card["context"] = CONTEXTS[cid]

    with open(CARDS_PATH, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Added context to {len(data['cards'])} cards. Wrote {CARDS_PATH}")


if __name__ == "__main__":
    main()
