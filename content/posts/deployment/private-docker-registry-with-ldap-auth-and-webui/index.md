---
title: "带LDAP认证与WebUI的Docker私有仓库搭建"
date: 2019-07-22T16:37:55+08:00
draft: false
tags: ["Deployment"]
categories: ["Docker"]

resources:
- name: featured-image
  src: config.jpg
---

# 带LDAP认证与WebUI的Docker私有仓库搭建

## 1. 获取docker仓库并运行

```bash
docker pull registry:latest
docker run -d -p 127.0.0.1:5000:5000 --name registry-localhost -v /opt/docker-registry:/var/lib/registry --restart=always registry:latest
```

## 2. 获取WebUI并运行

*Docker Registry的WebUI有很多，这里使用konradkleine/docker-registry-frontend:v2*

```bash
docker pull konradkleine/docker-registry-frontend:v2
docker run -d -e ENV_DOCKER_REGISTRY_HOST=barricade.ivic.org.cn -e ENV_DOCKER_REGISTRY_PORT=80 -p 127.0.0.1:8081:80 --restart=always --name frontend-localhost konradkleine/docker-registry-frontend:v2
```

## 3. 搭建带有LDAP认证的Nginx服务

预编译版本的nginx默认不带有LDAP认证所需模块，需要手动编译nginx与拓展模块。

### 3.1 编译安装nginx依赖

```bash
# 编译安装pcre
wget ftp://ftp.csx.cam.ac.uk/pub/software/programming/pcre/pcre-8.42.tar.gz
tar -zxf pcre-8.42.tar.gz
cd pcre-8.42
./configure
make
sudo make install

# 编译安装zlib
wget http://zlib.net/zlib-1.2.11.tar.gz
tar -zxf zlib-1.2.11.tar.gz
cd zlib-1.2.11
./configure
make
sudo make install

# 如果没有安装openssl，请自行安装openssl
# ...

# 安装ldap依赖库
# Ubuntu/Debian
sudo apt install libldap2-dev
# CentOS
yum install openldap-devel
```

### 3.2 下载nginx与拓展模块源码

```bash
# 下载解压nginx源码
wget https://nginx.org/download/nginx-1.15.11.tar.gz
tar zxf nginx-1.15.11.tar.gz

# 下载解压nginx-auth-ldap
wget https://github.com/kvspb/nginx-auth-ldap/archive/master.zip
unzip master.zip
```

### 3.3 编译安装nginx

```bash
# 编译nginx
cd nginx-1.15.11
./configure --sbin-path=/usr/local/nginx/nginx --conf-path=/etc/nginx/nginx.conf --pid-path=/usr/local/nginx/nginx.pid --with-pcre=../pcre-8.42 --with-zlib=../zlib-1.2.11 --with-http_ssl_module --with-stream --with-mail=dynamic  --add-module=~/nginx-auth-ldap-master

make
sudo make install

# 创建软连接
sudo ln -s /usr/local/nginx/nginx /usr/bin/nginx
```

### 3.4 编写nginx配置文件/etc/nginx/nginx.conf

**注意替换ldap_server中参数，同时注意其他位置关于host与port的配置**

```
worker_processes  1;

events {
    worker_connections  1024;
}


http {

    upstream docker-registry {
        server localhost:5000;
    }

    ldap_server ldapserver {
	url ldap://<LDAP-SERVER-HOST>:<LDAP-SERVER-PORT>/<OU=...,DC=...>?samaccountname?sub?(objectClass=user);
        binddn <BINDDN>;
        binddn_passwd <PASSWORD-FOR-BINDDN>;
        group_attribute uniquemember;
        group_attribute_is_dn on;
    }
    
    server {

        listen 80;

        error_log /var/log/nginx/error.log debug;
        access_log /var/log/nginx/access.log;

        client_max_body_size 0;

        chunked_transfer_encoding on;

        location / {
            return 301 http://barricade.ivic.org.cn:80/v2;
        }



        location /v2/ {
                # Do not allow connections from docker 1.5 and earlier
                # docker pre-1.6.0 did not properly set the user agent on ping, catch "Go *" user agents
                if ($http_user_agent ~ "^(docker\/1\.(3|4|5(?!\.[0-9]-dev))|Go ).*$" ) {
                        return 404;
                }

                auth_ldap "Forbidden";
                auth_ldap_servers ldapserver;
                add_header 'Docker-Distribution-Api-Version' 'registry/2.0' always;

                proxy_pass                          http://docker-registry;
                    proxy_set_header  Host              $http_host;   # required for docker client's sake
                    proxy_set_header  X-Real-IP         $remote_addr; # pass on real client's IP
                    proxy_set_header  X-Forwarded-For   $proxy_add_x_forwarded_for;
                    proxy_set_header  X-Forwarded-Proto $scheme;
                    proxy_read_timeout                  900;
        }

    }

    server {

	listen 8080;

	error_log /var/log/nginx/error.log debug;
	access_log /var/log/nginx/access.log;

	client_max_body_size 0;
	chunked_transfer_encoding on;
	location / {

		auth_ldap "Forbidden";
		auth_ldap_servers ldapserver;
		proxy_pass http://localhost:8081;

	}

    }

}
```

### 3.5 配置Nginx服务管理与自启动

编写服务`/lib/systemd/system/nginx.service`

```bash
[Unit]
Description=nginx - high performance web server
Documentation=http://nginx.org/en/docs/
After=network.target

[Service]
Type=forking
ExecStartPre=/usr/local/nginx/nginx -t -c /etc/nginx/nginx.conf
ExecStart=/usr/local/nginx/nginx -c /etc/nginx/nginx.conf
ExecReload=/usr/local/nginx/nginx -s reload
ExecStop=/usr/local/nginx/nginx -s quit
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

启动Nginx服务并设置自启动

```bash
sudo systemctl daemon-reload
sudo systemctl start nginx
sudo systemctl status nginx
sudo systemctl enable nginx
```

## 4. 客户端配置

docker仅支持https的仓库，在内网中无需使用https，因此需要将仓库加入docker的白名单。

### 4.1 编写/etc/docker/daemon.json

```json
{
    "insecure-registries":[
        "barricade.ivic.org.cn"
    ]
}
```

### 4.2 重启docker服务

```bash
sudo systemctl restart docker
```
