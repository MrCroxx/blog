---
title: "Hugo Theme - Monument README"
date: 2019-07-01T18:01:14+08:00
draft: false
tags: ["Monument","theme","README"]
topics: ["Monument"]
---

# Hugo Theme - Monument

A colorful Hugo theme with various out-of-box features.

![screenshot](https://raw.githubusercontent.com/mrcroxx/hugo-theme-monument/master/images/screenshot.png)

**🎈[Demo](<https://hugo-theme-monument.github.io>)**
*If you are using Chrome, set [chrome://flags/#force-color-profile](<chrome://flags/#force-color-profile>) to sRGB to get a better performance.*

## Features

- [x] A posts and words counting chart on the home page.
- [x] Category links and social links on the sidebar.
- [x] Timeline organized posts and categories lists.
- [x] Automatic code highlighting supported by [highlight.js](https://highlightjs.org/).
- [x] Latex expression supported by [KaTeX](<https://katex.org/>).
- [x] Optional charting supported by [ChartJS](<https://www.chartjs.org/>).
- [x] Comment system supported by [Gitalk](<https://github.com/gitalk/gitalk>).
- [x] A TIME-SUCKING [404 page](<#404-page>). 
- ...

## Getting Started

### 1. Clone this repository to your hugo theme directory.

```bash
cd /path/to/your/hugo/site/
git submodule add https://github.com/mrcroxx/hugo-theme-monument.git themes/Monument
```

### 2. Switch your theme to *Monument* in your *config.toml*.

```toml
theme = "Monument"
```

### 3. Customize your site.

For more information read [Site Configuration](<#site-configuration>).

## Site Configuration
<a name="site-configuration"></a>

Take a look in the `exampleSite` folder first.

### Length of the summary

When using a language other than English (like Chinese), make sure of adding the config below to make the length of summaries right.

```toml
summaryLength = 40
hasCJKLanguage = true
```

### Menu Link

Take a look at the `config.toml` file in the `exampleSite` folder.

The icon of menu items can be customized by parameter `pre` with [Font-Awesome](https://fontawesome.com/).

### Social Link

See `layouts/partials/social.html` for more information. 

### Site Parameters

```toml
[params]
    brand = "Monument" # Showed at the top of the sidebar.
    subtitle = "A colorful Hugo theme with various out-of-box features."
    dateformat = "2006-01-02 15:04"
    math = true # Turn KaTeX support on.
    max_taxonomy_terms = 3 # Limit posts showed below tags or topics.
    highlightjs = "atom-one-light" # Customize the theme of highlightjs.
    highlightjs_extra_languages = ["yaml","kotlin"] # Add extra languages support.
    comment_system = "gitalk" # Turn Gitalk support on.
    comment_system_client_id = "xxx" 
    comment_system_client_secret = "xxx"
    comment_system_owner = "xxx"
    comment_system_repo = "xxx"
```

## Use ChartJS in Posts

The post page does not load `ChartJS` by default. You can turn it on by adding `"ChartJS"` to the `include` parameter of the markdown file.

```toml
+++
title = "xxx"
# ... ...
include = ["ChartJS"]
+++
```

## Content Suggestions

- Keep blog posts in `content/posts` directory.
- Use `tags` and `topics` as taxonomies.

## More Screenshots

### Home Page

![Home Page](<https://raw.githubusercontent.com/mrcroxx/hugo-theme-monument/master/images/screenshot-home.png>)

### Posts Page

![Posts Page](<https://raw.githubusercontent.com/mrcroxx/hugo-theme-monument/master/images/screenshot-posts.png>)

### KaTeX & ChartJS

![KaTeX & ChartJS](<https://raw.githubusercontent.com/mrcroxx/hugo-theme-monument/master/images/screenshot-katex-chartjs.png>)

### 404 Page
<a name="404-page"></a>
![404 Page](<https://raw.githubusercontent.com/mrcroxx/hugo-theme-monument/master/images/screenshot-404.gif>)
